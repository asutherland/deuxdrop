/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at:
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Mozilla Raindrop Code.
 *
 * The Initial Developer of the Original Code is
 *   The Mozilla Foundation
 * Portions created by the Initial Developer are Copyright (C) 2011
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Andrew Sutherland <asutherland@asutherland.org>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

/**
 *
 **/

define(
  [
    'q', 'q-util',
    'exports'
  ],
  function(
    $Q, $Qutil,
    exports
  ) {
var when = $Q.when, whenAll = $Q.whenAll;

/**
 * The runtime context interacts with the log fab subsystem to indicate that we
 *  are in a testing mode and to associate actors with loggers.
 */
function TestRuntimeContext() {
  this._loggerStack = [];
  this._pendingActorsByLoggerType = {};
}
TestRuntimeContext.prototype = {
  /**
   * Push a logger onto the logger stack; the top of the stack becomes the
   *  parent logger for loggers that do not have an explicit parent logger at
   *  creation time.
   */
  pushLogger: function(logger) {
    this._loggerStack.push(logger);
  },

  /**
   * Remove a specific logger from the logger stack.  While the caller should
   *  be confident they are at the top of the stack, it's not required for
   *  data-structure correctness.  (We should possibly be asserting in that
   *  case...)
   */
  popLogger: function(logger) {
    var idx = this._loggerStack.lastIndexOf(logger);
    if (idx !== -1)
      this._loggerStack.splice(idx, 1);
  },

  /**
   * Used by actors preparing for a test step to register themselves for
   *  association with a logger of the matching type.
   */
  reportPendingActor: function(actor) {
    var type = actor.__defName;
    if (!this._pendingActorsByLoggerType.hasOwnProperty(type))
      this._pendingActorsByLoggerType[type] = [actor];
    else
      this._pendingActorsByLoggerType[type].push(actor);
  },

  /**
   * Logfabs that are told about this context invoke this method when creating a
   *  new logger so that we can hook up actors and insert containing parents.
   *
   * @args[
   *   @param[logger Logger]
   *   @param[curParentLogger @oneof[null Logger]]{
   *     The explicit parent of this logger, if one was provided to the logfab.
   *   }
   * ]
   * @return[@oneof[null Logger]]{
   *   The parent to use for this logger.  This will replace whatever value
   *   was passed in via `curParentLogger`, so `curParentLogger` should be
   *   returned in the intent is not to override the value.
   * }
   */
  reportNewLogger: function(logger, curParentLogger) {
    // - associate with any pending actors
    var type = logger.__defName;
    if (this._pendingActorsByLoggerType.hasOwnProperty(type) &&
        this._pendingActorsByLoggerType[type].length) {
      var actor = this._pendingActorsByLoggerType[type].shift();
      logger._actor = actor;
      actor._logger = logger;
      // There is no need to generate a fake __loggerFired notification because
      //  the logger is brand new and cannot have any entries at this point.
    }

    // - if there is no explicit parent, use the top of the logger stack
    if (!curParentLogger && this._loggerStack.length)
      return this._loggerStack[this._loggerStack.length - 1];
    return curParentLogger;
  },
};

/**
 * Consolidates the logic to run tests.
 */
function TestRunner(testDefiner) {
  this._testDefiner = testDefiner;
  this._runtimeContext = new TestRuntimeContext();
}
TestRunner.prototype = {
  /**
   * Asynchronously run a test step, non-rejecting promise-style.
   *
   * @return[Boolean]{
   *   A boolean indicator of whether the step passed.
   * }
   */
  runTestStep: function(step) {
    var iActor, actor;

    // -- notify the actors about their imminent use in a step
    for (iActor = 0; iActor < step.actors.length; iActor++) {
      actor = step.actors[iActor];
      actor.__prepForTestStep(this._runtimeContext);
    }

    // -- initiate the test function
    step.log.run_begin();
    // (this wraps and handles failures!)
    var rval = step.log.stepFunc(null, step.testFunc);
    // any kind of exception in the function is a failure.
    if (rval instanceof Error) {
      step.log.run_end();
      step.log.result('fail');
      return false;
    }

    // -- wait on actors' expectations (if any) promise-style
    var promises = [], allGood = true;
    for (iActor = 0; iActor < step.actors.length; iActor++) {
      actor = step.actors[iActor];
      var waitVal = actor.__waitForExpectations();
      if ($Q.isPromise(waitVal))
        promises.push(waitVal);
      // if it's not a promise, it must be a boolean
      else if (!waitVal)
        allGood = false;
    }

    if (!promises.length) {
      step.log.run_end();
      step.log.result(allGood ? 'pass' : 'fail');
      return allGood;
    }
    else {
      return whenAll(promises, function passed() {
        step.log.run_end();
        step.log.result('pass');
        return allGood;
      }, function failed(expPair) {
        // XXX we should do something with the failed expectation pair...
        step.log.run_end();
        step.log.result('fail');
        return false;
      });
    }
  },

  /**
   * Synchronously skip a test step, generating appropriate logging/reporting
   *  byproducts so it's clear the step was skipped rather than disappearing
   *  from the radar.
   */
  skipTestStep: function(step) {
    step.log.result('skip');
    return true;
  },

  /**
   * Run a specific permutation of a test-case.  The zeroth case of a
   *  permutation is special as it is also when the number of permutations is
   *  actually determined.
   * XXX we don't actually do anything with permutations right now.
   *
   * @return[Boolean]{
   *   A boolean indicator of whether the test passed.
   * }
   */
  runTestCasePermutation: function(testCase, permutationNum) {
    // Generate a fresh deferred that uses internal counting rather than chained
    //  promises for resolution.
    var deferred = $Q.defer(), self = this;

    // -- create / setup the context
    var defContext = new TestContext(testCase, 0);

    // - push the context's logger on the runtime logging stack
    // (We want all new logged objects to be associated with the context since
    //  it should bound their lifetimes.  Although it is interesting to know
    //  what specific step a logger came-to-life, we expect that to occur via
    //  cross-referencing.  If we anchored loggers in their creating step then
    //  the hierarchy would be extremely confusing.)
    self._runtimeContext.pushLogger(defContext._log);

    // -- process the steps
    // In event of a setup/action failure, change to only running cleanup steps.
    var allPassed = true, iStep = 0;
    function runNextStep(passed) {
      if (!passed)
        allPassed = false;
      // -- done case
      if (iStep >= defContext._steps.length) {
        // - pop the test-case logger from the logging context stack
        self._runtimeContext.popLogger(defContext._log);

        // - resolve!
        deferred.resolve(allPassed);
      }

      // -- yet another step case
      var step = defContext._steps[iStep++];
      var runIt = allPassed || (step.kind === 'cleanup');
      if (runIt)
        when(self.runTestStep(step), runNextStep);
      else // for stack simplicity, run the skip in a when, but not required.
        when(self.skipTestStep(step), runNextStep);
    }
    runNextStep();

    return deferred.promise;
  },

  runTestCase: function(testCase) {
    return this.runTestCasePermutation(testCase, 0);
  },

  runAll: function() {
    var deferred = $Q.defer(), iTestCase = 0, definer = this._testDefiner,
        self = this;
    function runNextTestCase() {
      if (iTestCase >= definer._testCases.length) {
        deferred.resolve();
        return;
      }
      var testCase = definer._testCases[iTestCase++];
      when(self.runTestCase(testCase), runNextTestCase);
    }
    runNextTestCase();
    return deferred.promise;
  },
};

exports.runTestsFromModule = function runTestsFromModule(tmod) {
  var runner = new TestRunner(tmod.TD);
  return runner.runAll();
};

}); // end define
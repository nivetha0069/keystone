/**
 * Test-only Phase D suite. Proposed sys_script_include sys_id:
 * 4b9cb8a893520750410e383efaba1092
 *
 * Run from Scripts - Background:
 * new DotwalkersPhaseDTests().run(); // expected 32/32
 */
var DotwalkersPhaseDTests = Class.create();

DotwalkersPhaseDTests.prototype = {
    initialize: function() {
        this.RUN = '11111111111111111111111111111111';
        this.CI = '22222222222222222222222222222222';
        this.FINDING = '33333333333333333333333333333333';
        this.REVIEW = '44444444444444444444444444444444';
        this.USER = '55555555555555555555555555555555';
        this.APPROVAL = '66666666666666666666666666666666';
        this.RESUME_CLAIM = '77777777777777777777777777777777';
        this.PREPARED = '88888888888888888888888888888888';
        this.EXECUTION = '99999999999999999999999999999999';
        this.TARGET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
        this.FP = new Array(33).join('A1');
    },

    run: function() {
        var tests = [
            'testExactPreparedBindingAccepted',
            'testPreparedUnknownFieldRejected',
            'testLegacyFingerprintRejected',
            'testMalformedFingerprintRejected',
            'testNewestSimulationRequired',
            'testCanonicalFingerprintRecomputed',
            'testMismatchedFingerprintRejected',
            'testMissingDeferredReviewRejected',
            'testMissingApprovalRejected',
            'testMissingResumeClaimRejected',
            'testMissingPreparedMarkerRejected',
            'testManualReviewRejected',
            'testLegacyReviewRejected',
            'testRoleRejected',
            'testTeamOwnershipRejected',
            'testRunOwnershipRejected',
            'testIdentifierOnlyOperationRejected',
            'testIdentifierOnlyTargetRejected',
            'testIdentifierOnlyPayloadMappingStrategyRejected',
            'testAtomicExecutionClaimOneWinner',
            'testExactlyOneMockedIreCommit',
            'testDuplicateReplayDoesNotCommitAgain',
            'testConflictingReplayRejected',
            'testPreCommitRetryIsDeterministic',
            'testAmbiguousInvocationRequiresReconciliation',
            'testErrorsAreSanitized',
            'testExactlyOneVerificationContinuation',
            'testAtomicVerificationClaimOneWinner',
            'testVerificationTransportRetryNeverExecutes',
            'testVerificationMismatchNeverExecutes',
            'testCompactLedgerExcludesSensitiveFields',
            'testNoLiveDependencyOrGlobalPatch'
        ];
        var passed = 0;
        var failures = [];
        for (var i = 0; i < tests.length; i++) {
            try {
                this[tests[i]]();
                passed++;
            } catch (error) {
                failures.push(tests[i] + ': ' + (error && error.message ? error.message : String(error)));
            }
        }
        var result = { passed: passed, failed: tests.length - passed, total: tests.length, failures: failures };
        gs.info('Dotwalkers Phase D tests: ' + passed + '/' + tests.length + ' passed.');
        if (failures.length) gs.error(JSON.stringify(failures));
        return result;
    },

    testExactPreparedBindingAccepted: function() {
        var token = this._service()._validatePreparedContinuation(this._prepared());
        this._assert(token.migration_run_id === this.RUN && token.simulation_fingerprint === this.FP, 'exact prepared binding');
    },

    testPreparedUnknownFieldRejected: function() {
        var prepared = this._prepared();
        prepared.operation = 'UPDATE';
        this._assertThrows(function() { new DotwalkersIreSimulationService()._validatePreparedContinuation(prepared); });
    },

    testLegacyFingerprintRejected: function() {
        var prepared = this._prepared();
        prepared.simulation_fingerprint = new Array(33).join('A');
        this._assertThrows(function() { new DotwalkersIreSimulationService()._validatePreparedContinuation(prepared); });
    },

    testMalformedFingerprintRejected: function() {
        var prepared = this._prepared();
        prepared.simulation_fingerprint = 'not-canonical';
        this._assertThrows(function() { new DotwalkersIreSimulationService()._validatePreparedContinuation(prepared); });
    },

    testNewestSimulationRequired: function() {
        var svc = this._authorityService();
        svc._latestCompletedSimulation = function() { return null; };
        this._assertThrows(function() { svc._executionAuthority(this._binding()); }.bind(this));
    },

    testCanonicalFingerprintRecomputed: function() {
        var authority = this._authorityService()._executionAuthority(this._binding());
        this._assert(authority.simulation_fingerprint === this.FP, 'canonical fingerprint recomputed');
    },

    testMismatchedFingerprintRejected: function() {
        var svc = this._authorityService();
        svc._newPayloadService = function() {
            return {
                build: function() { return { ire_payload: { items: [{ className: 'cmdb_ci_server', values: { name: 'server-1' } }] } }; },
                fingerprintSimulation: function() { return new Array(65).join('B'); }
            };
        };
        this._assertThrows(function() { svc._executionAuthority(this._binding()); }.bind(this));
    },

    testMissingDeferredReviewRejected: function() {
        this._assertContinuationRejected('REVIEW_BINDING_MISSING');
    },

    testMissingApprovalRejected: function() {
        this._assertContinuationRejected('TOKEN_NOT_FOUND');
    },

    testMissingResumeClaimRejected: function() {
        var svc = this._continuationService();
        svc._findLatestBindingAction = function(binding, action) {
            if (action === 'approval_resume_prepared') return { sys_id: this.PREPARED, detail: { claim_event_id: this.RESUME_CLAIM } };
            return null;
        }.bind(this);
        this._assert(svc.continuePreparedApproval(this._prepared()).code === 'PREPARED_EVIDENCE_MISSING', 'resume claim required');
    },

    testMissingPreparedMarkerRejected: function() {
        var svc = this._continuationService();
        svc._findLatestBindingAction = function(binding, action) {
            if (action === 'approval_resume_claimed') return { sys_id: this.RESUME_CLAIM, detail: {} };
            return null;
        }.bind(this);
        this._assert(svc.continuePreparedApproval(this._prepared()).code === 'PREPARED_EVIDENCE_MISSING', 'prepared marker required');
    },

    testManualReviewRejected: function() {
        this._assertContinuationRejected('REVIEW_STATE_INVALID');
    },

    testLegacyReviewRejected: function() {
        this._assertContinuationRejected('REVIEW_BINDING_MISSING');
    },

    testRoleRejected: function() {
        var svc = this._service();
        svc._currentUserId = function() { return this.USER; }.bind(this);
        svc._callerHasRole = function() { return false; };
        this._assertThrows(function() { svc._validateCaller(); });
    },

    testTeamOwnershipRejected: function() {
        var svc = this._service();
        var binding = this._binding();
        binding.run_record = this._record({ team_prefix: 'OTHER', initiated_by: this.USER });
        binding.review_record = this._record({ team_prefix: svc.TEAM, decided_by: this.USER });
        this._assertThrows(function() { svc._validateExecutionOwnership(binding); });
    },

    testRunOwnershipRejected: function() {
        var svc = this._service();
        svc._callerHasRole = function() { return false; };
        var binding = this._binding();
        binding.run_record = this._record({ team_prefix: svc.TEAM, initiated_by: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
        binding.review_record = this._record({ team_prefix: svc.TEAM, decided_by: this.USER });
        this._assertThrows(function() { svc._validateExecutionOwnership(binding); });
    },

    testIdentifierOnlyOperationRejected: function() {
        this._assertPreparedFieldRejected('operation', 'UPDATE');
    },

    testIdentifierOnlyTargetRejected: function() {
        this._assertPreparedFieldRejected('target_ci_sys_id', this.TARGET);
    },

    testIdentifierOnlyPayloadMappingStrategyRejected: function() {
        var forbidden = ['payload', 'values', 'class_name', 'mapping', 'strategy', 'decision', 'rationale', 'credentials', 'prompts'];
        for (var i = 0; i < forbidden.length; i++) this._assertPreparedFieldRejected(forbidden[i], 'untrusted');
    },

    testAtomicExecutionClaimOneWinner: function() {
        this._assertAtomicClaim('ire_execution_claimed', 'analyzed');
    },

    testExactlyOneMockedIreCommit: function() {
        var calls = { commit: 0, verify: 0 };
        var svc = this._commitService(calls);
        var result = svc.continuePreparedApproval(this._prepared());
        this._assert(result.success === true && calls.commit === 1 && calls.verify === 1, 'one IRE commit and one verification');
    },

    testDuplicateReplayDoesNotCommitAgain: function() {
        var calls = { commit: 0, verify: 0 };
        var svc = this._commitService(calls);
        svc._findPhaseDAction = function(binding, action) {
            if (action === 'ire_execution_completed') return this._executionEvent();
            return null;
        }.bind(this);
        svc.continuePreparedApproval(this._prepared());
        this._assert(calls.commit === 0 && calls.verify === 1, 'completed replay performs no commit');
    },

    testConflictingReplayRejected: function() {
        var calls = { commit: 0, verify: 0 };
        var svc = this._commitService(calls);
        svc._findConflictingExecution = function() { return { sys_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }; };
        var result = svc.continuePreparedApproval(this._prepared());
        this._assert(result.code === 'EXECUTION_REPLAY_CONFLICT' && calls.commit === 0, 'conflict stops commit');
    },

    testPreCommitRetryIsDeterministic: function() {
        var svc = this._service();
        svc._insertPhaseDEvent = function() { return { won: true }; };
        var first = svc._recordExecutionPreCommitFailure(this._binding(), this.PREPARED, {
            root_execution_claim_id: this.EXECUTION,
            execution_claim_id: this.EXECUTION,
            retry_count: 0
        }, 'EXECUTION_PRECOMMIT_FAILED');
        var second = svc._recordExecutionPreCommitFailure(this._binding(), this.PREPARED, {
            root_execution_claim_id: this.EXECUTION,
            execution_claim_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
            retry_count: 1
        }, 'EXECUTION_PRECOMMIT_FAILED');
        this._assert(first.retryable === true && second.retryable === false, 'only one deterministic pre-commit retry');
    },

    testAmbiguousInvocationRequiresReconciliation: function() {
        var calls = { commit: 0, verify: 0 };
        var svc = this._commitService(calls);
        svc._createOrUpdateCi = function() { calls.commit++; throw new Error('raw secret payload'); };
        svc._recordExecutionReconciliation = function() {
            return this._phaseDError('EXECUTION_RECONCILIATION_REQUIRED', 'sanitized', false, 503);
        };
        var result = svc.continuePreparedApproval(this._prepared());
        this._assert(calls.commit === 1 && calls.verify === 0 && result.retryable === false, 'ambiguous IRE invocation never retries');
    },

    testErrorsAreSanitized: function() {
        var result = this._service()._phaseDError('EXECUTION_RECONCILIATION_REQUIRED', 'sanitized', false, 503);
        var text = JSON.stringify(result);
        this._assert(text.indexOf('payload') < 0 && text.indexOf('Glide') < 0 && text.indexOf('credential') < 0, 'compact sanitized error');
    },

    testExactlyOneVerificationContinuation: function() {
        var calls = { commit: 0, verify: 0 };
        this._commitService(calls).continuePreparedApproval(this._prepared());
        this._assert(calls.verify === 1, 'exactly one verification continuation');
    },

    testAtomicVerificationClaimOneWinner: function() {
        this._assertAtomicClaim('ire_verification_claimed', 'analyzed');
    },

    testVerificationTransportRetryNeverExecutes: function() {
        var executionCalls = 0;
        var svc = this._verificationService();
        svc._createOrUpdateCi = function() { executionCalls++; throw new Error('must not execute'); };
        svc._readTargetCi = function() { throw new Error('transport'); };
        svc._recordVerificationTransportFailure = function() { return this._phaseDError('VERIFICATION_TRANSPORT_FAILED', 'sanitized', true, 503); };
        var result = svc._continueVerification(this._binding(), this._executionEvent(), true);
        this._assert(result.code === 'VERIFICATION_TRANSPORT_FAILED' && executionCalls === 0, 'verification retry never executes');
    },

    testVerificationMismatchNeverExecutes: function() {
        var executionCalls = 0;
        var recordedPass = true;
        var svc = this._verificationService();
        svc._createOrUpdateCi = function() { executionCalls++; };
        svc._readTargetCi = function() { return this._record({ sys_class_name: 'cmdb_ci_server', name: 'wrong-name' }); }.bind(this);
        svc._recordVerificationOutcome = function(binding, execution, claim, passed) {
            recordedPass = passed;
            return { success: true, state: passed ? 'verified' : 'verification_failed' };
        };
        svc._continueVerification(this._binding(), this._executionEvent(), false);
        this._assert(recordedPass === false && executionCalls === 0, 'mismatch is terminal without Execute');
    },

    testCompactLedgerExcludesSensitiveFields: function() {
        var detail = JSON.parse(new DotwalkersAgentEventDetailService().build({
            phase: 'remediate',
            action: 'ire_execution_completed',
            status: 'completed',
            migration_run_id: this.RUN,
            staged_ci_id: this.CI,
            target_ci_sys_id: this.TARGET,
            operation: 'UPDATE',
            payload: { values: { password: 'secret' } },
            source_row: { secret: true },
            prompt: 'secret',
            credentials: 'secret',
            class_mapping: 'secret'
        }));
        var text = JSON.stringify(detail);
        this._assert(text.indexOf('password') < 0 && text.indexOf('source_row') < 0 && text.indexOf('prompt') < 0 && text.indexOf('credentials') < 0 && text.indexOf('class_mapping') < 0, 'sensitive evidence excluded');
    },

    testNoLiveDependencyOrGlobalPatch: function() {
        var calls = { commit: 0, verify: 0 };
        var svc = this._commitService(calls);
        this._assert(svc._newRecord !== GlideRecord && calls.commit === 0, 'dependencies are instance overrides, not global patches');
    },

    _service: function() {
        var svc = new DotwalkersIreSimulationService();
        svc._sha256 = function(value) {
            return String(new GlideDigest().getSHA256Hex(String(value || ''))).toLowerCase();
        };
        return svc;
    },

    _binding: function() {
        return {
            migration_run_id: this.RUN,
            staged_ci_id: this.CI,
            finding_id: this.FINDING,
            review_decision_id: this.REVIEW,
            correlation_id: 'ks-approve-test',
            idempotency_key: 'approve:test',
            simulation_correlation_id: 'ks-simulate-test',
            simulation_fingerprint: this.FP,
            approval_event_id: this.APPROVAL,
            decision: 'approved',
            decision_source: 'deterministic',
            decided_by: this.USER,
            policy_approved: false
        };
    },

    _prepared: function() {
        return {
            success: true,
            state: 'approval_resume_prepared',
            migration_run_id: this.RUN,
            staged_ci_id: this.CI,
            approval_event_id: this.APPROVAL,
            simulation_correlation_id: 'ks-simulate-test',
            simulation_fingerprint: this.FP,
            continuation_ready: true,
            executed: false,
            verified: false,
            cmdb_committed: false
        };
    },

    _executionEvent: function() {
        return {
            sys_id: this.EXECUTION,
            detail: {
                action: 'ire_execution_completed',
                migration_run_id: this.RUN,
                staged_ci_id: this.CI,
                finding_id: this.FINDING,
                review_decision_id: this.REVIEW,
                correlation_id: 'ks-approve-test',
                idempotency_key: 'approve:test',
                simulation_correlation_id: 'ks-simulate-test',
                simulation_fingerprint: this.FP,
                approval_event_id: this.APPROVAL,
                decision: 'approved',
                decision_source: 'deterministic',
                policy_approved: false,
                execution_event_id: this.EXECUTION,
                target_ci_sys_id: this.TARGET,
                operation: 'UPDATE'
            }
        };
    },

    _record: function(values) {
        return {
            getValue: function(name) { return values[name] || ''; }
        };
    },

    _authorityService: function() {
        var svc = this._service();
        var self = this;
        svc._latestCompletedSimulation = function() {
            return {
                action: 'ire_simulation_completed',
                migration_run_id: self.RUN,
                staged_ci_id: self.CI,
                finding_id: self.FINDING,
                simulation_correlation_id: 'ks-simulate-test',
                simulation_fingerprint: self.FP,
                operation: 'UPDATE',
                simulation_matched_ci: self.TARGET
            };
        };
        svc._newPayloadService = function() {
            return {
                build: function() {
                    return {
                        proposed_class: 'cmdb_ci_server',
                        authoritative_values: { name: 'server-1' },
                        ire_payload: { items: [{ className: 'cmdb_ci_server', values: { name: 'server-1' } }] }
                    };
                },
                fingerprintSimulation: function() { return self.FP; }
            };
        };
        svc._identifyCi = function() { throw new Error('identifyCI must not run'); };
        return svc;
    },

    _continuationService: function() {
        var svc = this._service();
        var self = this;
        var binding = this._binding();
        svc._validateCaller = function() {};
        svc._bindingFromApprovalEvent = function() { return binding; };
        svc._validateExecutionOwnership = function() {};
        svc._findLatestBindingAction = function(subject, action) {
            if (action === 'approval_resume_claimed') return { sys_id: self.RESUME_CLAIM, detail: {} };
            if (action === 'approval_resume_prepared') return { sys_id: self.PREPARED, detail: { claim_event_id: self.RESUME_CLAIM } };
            return null;
        };
        svc._getEvent = function(id) { return { sys_id: id, detail: { action: 'approval_resume_claimed' } }; };
        svc._detailMatchesBinding = function() { return true; };
        svc._executionAuthority = function() { return { ire_input: '{"items":[]}' }; };
        svc._findConflictingExecution = function() { return null; };
        svc._findPhaseDAction = function() { return null; };
        return svc;
    },

    _commitService: function(calls) {
        var svc = this._continuationService();
        var self = this;
        svc._acquireExecutionClaim = function() {
            return { claimed: true, root_execution_claim_id: self.EXECUTION, execution_claim_id: self.EXECUTION, retry_count: 0 };
        };
        svc._prepareIreCommit = function() {};
        svc._createOrUpdateCi = function() {
            calls.commit++;
            return JSON.stringify({ items: [{ sysId: self.TARGET, operation: 'UPDATE', errors: [] }] });
        };
        svc._insertPhaseDEvent = function(binding, eventType, action, eventId, extra) {
            return { won: true, sys_id: eventId, detail: {
                action: action,
                migration_run_id: binding.migration_run_id,
                staged_ci_id: binding.staged_ci_id,
                finding_id: binding.finding_id,
                review_decision_id: binding.review_decision_id,
                correlation_id: binding.correlation_id,
                idempotency_key: binding.idempotency_key,
                simulation_correlation_id: binding.simulation_correlation_id,
                simulation_fingerprint: binding.simulation_fingerprint,
                approval_event_id: binding.approval_event_id,
                decision: 'approved',
                decision_source: 'deterministic',
                policy_approved: false,
                execution_event_id: eventId,
                target_ci_sys_id: extra.target_ci_sys_id,
                operation: extra.operation
            } };
        };
        svc._continueVerification = function() { calls.verify++; return { success: true, state: 'verified' }; };
        return svc;
    },

    _verificationService: function() {
        var svc = this._authorityService();
        svc._detailMatchesBinding = function() { return true; };
        svc._findPhaseDAction = function() { return null; };
        svc._acquireVerificationClaim = function() {
            return { claimed: true, root_verification_claim_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', verification_claim_id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', retry_count: 0 };
        };
        return svc;
    },

    _assertContinuationRejected: function(code) {
        var svc = this._continuationService();
        svc._bindingFromApprovalEvent = function() { throw this._bindingError(409, code, 'raw details never returned'); };
        var result = svc.continuePreparedApproval(this._prepared());
        this._assert(result.code === code && JSON.stringify(result).indexOf('raw details') < 0, code + ' sanitized');
    },

    _assertPreparedFieldRejected: function(field, value) {
        var prepared = this._prepared();
        prepared[field] = value;
        this._assertThrows(function() { new DotwalkersIreSimulationService()._validatePreparedContinuation(prepared); });
    },

    _assertAtomicClaim: function(action, eventType) {
        var env = this._atomicEnvironment();
        var svcA = env.service();
        var svcB = env.service();
        var binding = this._binding();
        var eventId = svcA._claimId(action, [this.RUN, this.CI, this.APPROVAL, this.PREPARED, this.FP]);
        var extra = { execution_claim_id: eventId };
        if (action === 'ire_verification_claimed') extra = { verification_claim_id: eventId };
        var first = svcA._insertPhaseDEvent(binding, eventType, action, eventId, extra, Object.keys(extra));
        var second = svcB._insertPhaseDEvent(binding, eventType, action, eventId, extra, Object.keys(extra));
        this._assert(first.won === true && second.won === false, 'one atomic claimant');
    },

    _atomicEnvironment: function() {
        var records = {};
        var self = this;
        function FakeRecord() { this.values = {}; this.id = ''; }
        FakeRecord.prototype.initialize = function() { this.values = {}; this.id = ''; };
        FakeRecord.prototype.setNewGuidValue = function(id) { this.id = String(id); };
        FakeRecord.prototype.setValue = function(name, value) { this.values[name] = value; };
        FakeRecord.prototype.getValue = function(name) { return this.values[name] || ''; };
        FakeRecord.prototype.getUniqueValue = function() { return this.id; };
        FakeRecord.prototype.isValidField = function() { return true; };
        FakeRecord.prototype.insert = function() {
            if (records[this.id]) throw new Error('duplicate primary key');
            records[this.id] = { values: JSON.parse(JSON.stringify(this.values)) };
            return this.id;
        };
        FakeRecord.prototype.get = function(id) {
            if (!records[id]) return false;
            this.id = id;
            this.values = JSON.parse(JSON.stringify(records[id].values));
            return true;
        };
        return {
            service: function() {
                var svc = self._service();
                svc._newRecord = function() { return new FakeRecord(); };
                svc._nextSequence = function() { return 1; };
                return svc;
            }
        };
    },

    _assertThrows: function(callback) {
        var threw = false;
        try { callback(); } catch (ignored) { threw = true; }
        this._assert(threw, 'expected exception');
    },

    _assert: function(condition, message) {
        if (!condition) throw new Error(message || 'assertion failed');
    },

    type: 'DotwalkersPhaseDTests'
};

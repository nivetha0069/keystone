/**
 * Test-only Phase C suite. Install as sys_script_include
 * 2a2cc9589316cf10410e383efaba102f and run from Scripts - Background.
 */
var DotwalkersPhaseCTests = Class.create();

DotwalkersPhaseCTests.prototype = {
    initialize: function() {
        this.RUN = '11111111111111111111111111111111';
        this.CI = '22222222222222222222222222222222';
        this.FINDING = '33333333333333333333333333333333';
        this.REVIEW = '44444444444444444444444444444444';
        this.USER = '55555555555555555555555555555555';
        this.FP = new Array(33).join('A1');
    },

    run: function() {
        var tests = [
            'testExactIdentifierRequest',
            'testUnknownFieldRejected',
            'testLegacyFingerprintRejected',
            'testMalformedFingerprintRejected',
            'testMissingApprovalIdentifierRejected',
            'testCanonicalFingerprintAccepted',
            'testApprovalClaimBindsExactRecords',
            'testApprovalClaimChangesWithStagedCi',
            'testApprovalClaimIgnoresCallerIdempotency',
            'testExactParsedBindingRequired',
            'testMismatchedCorrelationRejected',
            'testMismatchedIdempotencyRejected',
            'testFixedDecisionValues',
            'testCompactEvidenceExcludesSensitiveData',
            'testGuestRejected',
            'testRoleRejected',
            'testOwnershipErrorIsSanitized',
            'testInvalidReviewStateIsSanitized',
            'testAtomicApprovalClaimOneWinner',
            'testDuplicateApprovalClaimIsReplay',
            'testConflictingApprovalClaimRejected',
            'testExactlyOneMockedEventHandoff',
            'testQueueFailureSanitizedAndRetryable',
            'testQueueFailureEvidenceCompact',
            'testExactRetryReusesApprovalBinding',
            'testConflictingRetryRejected',
            'testConcurrentRetryClaimOneWinner',
            'testMalformedResumeTokenRejected',
            'testTokenRereadPrecedesClaim',
            'testReentrantResumeClaimOneWinner',
            'testReplayNeverPreparesTwice',
            'testPreparedRecordedAfterPreparation',
            'testPreparationFailureTerminal',
            'testMaraPreparationIdentifierOnly',
            'testNoExecuteVerifyOrCmdbWrite',
            'testNoGlobalPatchOrCrossScopeRead'
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
        gs.info('Dotwalkers Phase C tests: ' + passed + '/' + tests.length + ' passed.');
        if (failures.length) gs.error(JSON.stringify(failures));
        return result;
    },

    testExactIdentifierRequest: function() {
        var normalized = this._service()._validateApprovalRequest(this._request());
        this._assert(Object.keys(normalized).length === 8, 'exact eight fields required');
    },

    testUnknownFieldRejected: function() {
        var request = this._request();
        request.payload = { secret: true };
        this._assertThrows(function() { new DotwalkersIreSimulationService()._validateApprovalRequest(request); });
    },

    testLegacyFingerprintRejected: function() {
        var request = this._request();
        request.simulation_fingerprint = new Array(33).join('A');
        this._assertThrows(function() { new DotwalkersIreSimulationService()._validateApprovalRequest(request); });
    },

    testMalformedFingerprintRejected: function() {
        var request = this._request();
        request.simulation_fingerprint = 'not-a-fingerprint';
        this._assertThrows(function() { new DotwalkersIreSimulationService()._validateApprovalRequest(request); });
    },

    testMissingApprovalIdentifierRejected: function() {
        var request = this._request();
        delete request.review_decision_id;
        this._assertThrows(function() { new DotwalkersIreSimulationService()._validateApprovalRequest(request); });
    },

    testCanonicalFingerprintAccepted: function() {
        this._assert(this._service()._validateApprovalRequest(this._request()).simulation_fingerprint === this.FP, 'canonical fingerprint');
    },

    testApprovalClaimBindsExactRecords: function() {
        this._assert(/^[0-9a-f]{32}$/.test(this._approvalId(this._binding())), 'deterministic sys_id');
    },

    testApprovalClaimChangesWithStagedCi: function() {
        var a = this._binding();
        var b = this._binding();
        b.staged_ci_id = '66666666666666666666666666666666';
        this._assert(this._approvalId(a) !== this._approvalId(b), 'staged CI must affect claim');
    },

    testApprovalClaimIgnoresCallerIdempotency: function() {
        var a = this._binding();
        var b = this._binding();
        b.idempotency_key = 'different';
        this._assert(this._approvalId(a) === this._approvalId(b), 'idempotency must not select approval event id');
    },

    testExactParsedBindingRequired: function() {
        var svc = this._service();
        var binding = this._binding();
        var detail = svc._bindingDetail(binding, 'approval_recorded', { decided_by: this.USER });
        this._assert(svc._detailMatchesBinding(detail, binding, 'approval_recorded'), 'exact detail should match');
    },

    testMismatchedCorrelationRejected: function() {
        this._assertBindingMismatch('correlation_id', 'different');
    },

    testMismatchedIdempotencyRejected: function() {
        this._assertBindingMismatch('idempotency_key', 'different');
    },

    testFixedDecisionValues: function() {
        var detail = this._service()._bindingDetail(this._binding(), 'approval_recorded', {});
        this._assert(detail.decision === 'approved' && detail.decision_source === 'deterministic' && detail.policy_approved === false, 'server enums');
    },

    testCompactEvidenceExcludesSensitiveData: function() {
        var built = JSON.parse(new DotwalkersAgentEventDetailService().build(this._service()._bindingDetail(this._binding(), 'approval_recorded', {})));
        var text = JSON.stringify(built);
        this._assert(!/payload|prompt|credential|rationale|class_mapping|source_row/i.test(text), 'sensitive fields excluded');
    },

    testGuestRejected: function() {
        var svc = this._service();
        svc._validateCaller = function() { var e = new Error('guest'); e.error_code = 'UNAUTHORIZED'; throw e; };
        this._assert(svc.approve(this._request()).http_status === 401, 'guest must be rejected');
    },

    testRoleRejected: function() {
        var svc = this._service();
        svc._validateCaller = function() { var e = new Error('role'); e.error_code = 'FORBIDDEN'; throw e; };
        this._assert(svc.approve(this._request()).http_status === 403, 'role must be rejected');
    },

    testOwnershipErrorIsSanitized: function() {
        this._assertApprovalBindingError('RUN_OWNERSHIP_REJECTED');
    },

    testInvalidReviewStateIsSanitized: function() {
        this._assertApprovalBindingError('REVIEW_STATE_INVALID');
    },

    testAtomicApprovalClaimOneWinner: function() {
        var env = this._ledgerEnvironment();
        var binding = this._binding();
        var first = env.service()._insertBindingEvent(binding, 'approved', 'approval_recorded', binding.approval_event_id, {});
        var second = env.service()._insertBindingEvent(binding, 'approved', 'approval_recorded', binding.approval_event_id, {});
        this._assert(first.won && !second.won, 'one insert winner');
    },

    testDuplicateApprovalClaimIsReplay: function() {
        var env = this._ledgerEnvironment();
        var binding = this._binding();
        env.service()._insertBindingEvent(binding, 'approved', 'approval_recorded', binding.approval_event_id, {});
        this._assert(env.service()._insertBindingEvent(binding, 'approved', 'approval_recorded', binding.approval_event_id, {}).won === false, 'duplicate replay');
    },

    testConflictingApprovalClaimRejected: function() {
        var env = this._ledgerEnvironment();
        var binding = this._binding();
        env.service()._insertBindingEvent(binding, 'approved', 'approval_recorded', binding.approval_event_id, {});
        var conflict = this._binding();
        conflict.idempotency_key = 'conflict';
        this._assertThrows(function() { env.service()._insertBindingEvent(conflict, 'approved', 'approval_recorded', conflict.approval_event_id, {}); });
    },

    testExactlyOneMockedEventHandoff: function() {
        var calls = 0;
        var svc = this._handoffService(function() { calls++; });
        var result = svc._attemptApprovalHandoff(this._binding(), true);
        this._assert(result.success && calls === 1, 'one mocked queue call');
    },

    testQueueFailureSanitizedAndRetryable: function() {
        var svc = this._handoffService(function() { throw new Error('raw eventQueue exception'); });
        var result = svc._attemptApprovalHandoff(this._binding(), true);
        this._assert(!result.success && result.retryable && JSON.stringify(result).indexOf('raw eventQueue') < 0, 'sanitized retry');
    },

    testQueueFailureEvidenceCompact: function() {
        var recorded = [];
        var svc = this._handoffService(function() { throw new Error('secret'); }, recorded);
        svc._attemptApprovalHandoff(this._binding(), true);
        this._assert(recorded.some(function(item) { return item.action === 'approval_handoff_failed' && item.extra.error_code === 'MARA_EVENT_QUEUE_FAILED'; }), 'fixed failure evidence');
    },

    testExactRetryReusesApprovalBinding: function() {
        var binding = this._binding();
        var before = binding.approval_event_id;
        var svc = this._handoffRetryService(binding, false);
        svc._attemptApprovalHandoff(binding, false);
        this._assert(binding.approval_event_id === before, 'retry reuses approval event');
    },

    testConflictingRetryRejected: function() {
        var svc = this._service();
        var binding = this._binding();
        var detail = svc._bindingDetail(binding, 'approval_handoff_failed', {});
        binding.correlation_id = 'conflict';
        this._assert(!svc._detailMatchesBinding(detail, binding, 'approval_handoff_failed'), 'conflicting retry');
    },

    testConcurrentRetryClaimOneWinner: function() {
        var env = this._ledgerEnvironment();
        var binding = this._binding();
        var id = this._service()._claimId('approval-handoff-retry', [binding.approval_event_id, '77777777777777777777777777777777']);
        var one = env.service()._insertBindingEvent(binding, 'analyzed', 'approval_handoff_retry_claimed', id, {});
        var two = env.service()._insertBindingEvent(binding, 'analyzed', 'approval_handoff_retry_claimed', id, {});
        this._assert(one.won && !two.won, 'one retry claimant');
    },

    testMalformedResumeTokenRejected: function() {
        this._assert(this._service().validateAndClaimApprovalResume('bad', 'token').state === 'malformed_token', 'malformed token');
    },

    testTokenRereadPrecedesClaim: function() {
        var order = [];
        var svc = this._service();
        svc._bindingFromApprovalEvent = function() { order.push('reread'); return this._testBinding; };
        svc._testBinding = this._binding();
        svc._findLatestBindingAction = function() { return null; };
        svc._insertBindingEvent = function() { order.push('claim'); return { won: true }; };
        svc.validateAndClaimApprovalResume(this.RUN, this._binding().approval_event_id);
        this._assert(order.join(',') === 'reread,claim', 'reread before claim');
    },

    testReentrantResumeClaimOneWinner: function() {
        var env = this._ledgerEnvironment();
        var binding = this._binding();
        var id = this._service()._claimId('approval-resume', [this.RUN, this.CI, binding.approval_event_id, this.FP]);
        var one = env.service()._insertBindingEvent(binding, 'analyzed', 'approval_resume_claimed', id, {});
        var two = env.service()._insertBindingEvent(binding, 'analyzed', 'approval_resume_claimed', id, {});
        this._assert(one.won && !two.won, 'one resume claimant');
    },

    testReplayNeverPreparesTwice: function() {
        var calls = 0;
        var mara = new DotwalkersMaraAgent();
        var original = mara.prepareApprovalResume;
        if (this._service()._resumeResult(true, 'already_claimed', this._binding(), false).claimed) calls++;
        if (this._service()._resumeResult(true, 'claimed', this._binding(), true).claimed) { original.call(mara, this._binding()); calls++; }
        this._assert(calls === 1, 'one preparation call');
    },

    testPreparedRecordedAfterPreparation: function() {
        var prepared = new DotwalkersMaraAgent().prepareApprovalResume(this._binding());
        this._assert(prepared.success && prepared.state === 'approval_resume_prepared', 'preparation completes before marker');
    },

    testPreparationFailureTerminal: function() {
        var svc = this._service();
        var binding = this._binding();
        var detail = svc._bindingDetail(binding, 'approval_resume_failed', { error_code: 'MARA_PREPARATION_FAILED' });
        this._assert(detail.status === 'failed' && detail.error_code === 'MARA_PREPARATION_FAILED', 'terminal fixed failure');
    },

    testMaraPreparationIdentifierOnly: function() {
        var bad = this._binding();
        bad.payload = { forbidden: true };
        this._assert(new DotwalkersMaraAgent().prepareApprovalResume(bad).success === false, 'unknown payload rejected');
    },

    testNoExecuteVerifyOrCmdbWrite: function() {
        var calls = { identify: 0, execute: 0, verify: 0, write: 0 };
        var svc = this._handoffService(function() {});
        svc._identifyCi = function() { calls.identify++; };
        svc.execute = function() { calls.execute++; };
        svc.verifyExecution = function() { calls.verify++; };
        svc._cmdbWrite = function() { calls.write++; };
        svc._attemptApprovalHandoff(this._binding(), true);
        this._assert(JSON.stringify(calls) === JSON.stringify({ identify: 0, execute: 0, verify: 0, write: 0 }), 'no live action');
    },

    testNoGlobalPatchOrCrossScopeRead: function() {
        var tables = [];
        var calls = [];
        var svc = this._service();
        svc._newRecord = function(table) {
            tables.push(table);
            return {
                addQuery: function(field, value) { calls.push(['query', field, value]); },
                orderByDesc: function(field) { calls.push(['order', field]); },
                setLimit: function(value) { calls.push(['limit', value]); },
                query: function() { calls.push(['run']); },
                next: function() { return true; },
                getValue: function(field) {
                    calls.push(['value', field]);
                    return '61';
                }
            };
        };
        this._assert(svc._nextSequence(this.RUN) === 62, 'sequence continues from latest ledger record');
        this._assert(tables.length === 1 && tables[0] === svc.TABLES.ledger, 'ledger table only');
        this._assert(JSON.stringify(calls) === JSON.stringify([
            ['query', 'migration_run', this.RUN],
            ['order', 'sequence'],
            ['order', 'sys_created_on'],
            ['limit', 1],
            ['run'],
            ['value', 'sequence']
        ]), 'record-backed sequence lookup');
        this._assert(!svc.hasOwnProperty('GlideRecord'), 'instance dependencies only');
    },

    _service: function() {
        var svc = new DotwalkersIreSimulationService();
        svc._sha256 = function(value) { return new GlideDigest().getSHA256Hex(String(value)).toLowerCase(); };
        return svc;
    },

    _request: function() {
        return {
            migration_run_id: this.RUN,
            staged_ci_id: this.CI,
            finding_id: this.FINDING,
            review_decision_id: this.REVIEW,
            correlation_id: 'ks-approve-phase-c',
            idempotency_key: 'approve:phase-c:one',
            simulation_correlation_id: 'ks-simulate-phase-c',
            simulation_fingerprint: this.FP
        };
    },

    _binding: function() {
        var request = this._request();
        request.approval_event_id = this._approvalId(request);
        request.decision = 'approved';
        request.decision_source = 'deterministic';
        request.decided_by = this.USER;
        request.policy_approved = false;
        return request;
    },

    _approvalId: function(binding) {
        return this._service()._claimId('approval-recorded', [
            binding.migration_run_id, binding.staged_ci_id, binding.finding_id,
            binding.review_decision_id, binding.simulation_correlation_id,
            binding.simulation_fingerprint
        ]);
    },

    _assertBindingMismatch: function(field, value) {
        var svc = this._service();
        var binding = this._binding();
        var detail = svc._bindingDetail(binding, 'approval_recorded', {});
        binding[field] = value;
        this._assert(!svc._detailMatchesBinding(detail, binding, 'approval_recorded'), field + ' mismatch');
    },

    _assertApprovalBindingError: function(code) {
        var svc = this._service();
        svc._validateCaller = function() {};
        svc._resolveApprovalBinding = function() { throw this._bindingError(409, code, 'sanitized'); };
        var result = svc.approve(this._request());
        this._assert(result.code === code && JSON.stringify(result).indexOf('Glide') < 0, 'sanitized binding error');
    },

    _handoffService: function(queueFn, recorded) {
        var svc = this._service();
        recorded = recorded || [];
        svc._findLatestBindingAction = function() { return null; };
        svc._queueMaraEvent = queueFn;
        svc._insertBindingEvent = function(binding, eventType, action, eventId, extra) {
            recorded.push({ eventType: eventType, action: action, eventId: eventId, extra: extra || {} });
            return { won: true, sys_id: eventId };
        };
        return svc;
    },

    _handoffRetryService: function(binding, queueFailure) {
        var calls = 0;
        var svc = this._handoffService(function() { calls++; if (queueFailure) throw new Error('queue'); });
        svc._findLatestBindingAction = function(subject, action) {
            if (action === 'approval_handoff_failed') return { sys_id: '77777777777777777777777777777777', detail: {} };
            return null;
        };
        return svc;
    },

    _ledgerEnvironment: function() {
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
            records[this.id] = { id: this.id, values: JSON.parse(JSON.stringify(this.values)) };
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

    type: 'DotwalkersPhaseCTests'
};

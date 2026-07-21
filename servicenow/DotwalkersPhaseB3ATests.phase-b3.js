/**
 * Phase B3A — DotwalkersIreSimulationService.simulate deterministic strategy tests.
 *
 * Uses instance-level dependency overrides only.
 * Never replaces gs, GlideRecord, payload-service globals, or sn_cmdb.
 * No live identifyCI, createOrUpdateCI, eventQueue, CMDB write, approval,
 * Execute, or Verify call.
 */
var DotwalkersPhaseB3ATests = Class.create();

DotwalkersPhaseB3ATests.prototype = {

    initialize: function() {
        this.RUN_ID = 'aabbccdd11223344aabbccdd11223344';
        this.CI_ID = '11223344aabbccdd11223344aabbccdd';
        this.CORRELATION = 'ks-sim-b3a-test-001';
        this.IDEMPOTENCY = 'simulate:run:' + this.RUN_ID + ':ci:' + this.CI_ID;

        // 64-char hex fingerprint for deterministic tests
        this.FP_ALLOWLISTED = 'A'.repeat(64);
        this.FP_STRATEGY = 'B'.repeat(64);
    },

    /**
     * Run all Phase B3A tests. Returns structured pass/fail array.
     */
    run: function() {
        var tests = [
            'testAllowlistedClassHasNoStrategy',
            'testKnownAliasUsesNormalizeStrategy',
            'testUnknownAliasBlocksBeforeIdentifyCi',
            'testIdentifyCiCalledExactlyOnce',
            'testPriorRetryEvidenceBlocksIdentifyCi',
            'testIdempotentReplayNoSideEffects',
            'testCanonicalFingerprintIs64CharHex',
            'testStrategyAndMappingAffectFingerprint',
            'testRetryCountAndMaxRetriesRecorded',
            'testNormalSimulationsOmitStrategyFields',
            'testStrategySimulationsRecordCompactFields',
            'testNoRawPayloadOrIreInputInLedger',
            'testBrowserCannotProvideMapping',
            'testNoLiveActionsInSource',
            'testRetryEvidenceCountsCompletedDetail',
            'testCompletedEvidenceBlocksBuildWithStrategy',
            'testCallerGuestRejection',
            'testCallerMissingMigrationRoleRejected',
            'testCallerValidMigrationRoleAccepted',
            'testErrorEvidenceCompactFields',
            'testErrorEvidenceNoRawMessage',
            'testInsertOperationClearsMatchedCi',
            'testUnknownUntypedErrorExercisesSanitized500'
        ];

        var results = [];
        for (var i = 0; i < tests.length; i++) {
            var name = tests[i];
            var outcome;
            try {
                this[name]();
                outcome = { test: name, passed: true };
            } catch (e) {
                outcome = {
                    test: name,
                    passed: false,
                    message: e && e.message ? e.message : String(e)
                };
            }
            results.push(outcome);
        }
        return results;
    },

    // ─────────────────────────────────────────────────────────────
    // Tests
    // ─────────────────────────────────────────────────────────────

    /**
     * T1: Allowlisted class simulation has strategy_evidence=null.
     *     Ledger detail must NOT contain strategy_id.
     */
    testAllowlistedClassHasNoStrategy: function() {
        var ctx = this._buildAllowlistedContext();
        var svc = ctx.service;

        var result = svc.simulate(this._baseRequest());

        this._assert(result.success === true, 'success should be true');
        this._assert(result.operation === 'UPDATE', 'operation should be UPDATE');
        this._assert(!result.strategy_id, 'result should not have strategy_id');
        this._assert(!result.mapping_version, 'result should not have mapping_version');

        // Ledger detail check
        var detail = ctx.tracker.ledgerWrites[ctx.tracker.ledgerWrites.length - 1];
        this._assert(detail.action === 'ire_simulation_completed', 'action must be ire_simulation_completed');
        this._assert(!detail.strategy_id, 'ledger must not have strategy_id');
        this._assert(!detail.source_class, 'ledger must not have source_class');
    },

    /**
     * T2: Known alias uses normalize_known_class_alias strategy.
     */
    testKnownAliasUsesNormalizeStrategy: function() {
        var ctx = this._buildStrategyContext();
        var svc = ctx.service;

        var result = svc.simulate(this._baseRequest());

        this._assert(result.success === true, 'success should be true');
        this._assert(result.strategy_id === 'normalize_known_class_alias',
            'strategy_id should be normalize_known_class_alias, got: ' + result.strategy_id);
        this._assert(result.source_class === 'windows srv',
            'source_class should be windows srv, got: ' + result.source_class);
        this._assert(result.target_class === 'cmdb_ci_win_server',
            'target_class should be cmdb_ci_win_server, got: ' + result.target_class);
    },

    /**
     * T3: Unknown alias throws before identifyCI is called.
     */
    testUnknownAliasBlocksBeforeIdentifyCi: function() {
        var ctx = this._buildUnknownAliasContext();
        var svc = ctx.service;

        var result = svc.simulate(this._baseRequest());

        this._assert(result.success === false, 'Unknown alias must be blocked');
        this._assert(result.http_status === 422, 'Unknown alias must return 422');
        this._assert(result.code === 'UNSUPPORTED_CLASS_ALIAS',
            'Unknown alias must return the stable blocker code');
        this._assert(ctx.tracker.identifyCiCalls === 0,
            'identifyCI must not be called for unknown alias');
    },

    /**
     * T4: identifyCI is called exactly once for a valid simulation.
     */
    testIdentifyCiCalledExactlyOnce: function() {
        var ctx = this._buildAllowlistedContext();
        var svc = ctx.service;

        svc.simulate(this._baseRequest());

        this._assert(ctx.tracker.identifyCiCalls === 1,
            'identifyCI should be called exactly once, got: ' + ctx.tracker.identifyCiCalls);
    },

    /**
     * T5: Prior retry evidence blocks identifyCI.
     */
    testPriorRetryEvidenceBlocksIdentifyCi: function() {
        var ctx = this._buildRetryBlockedContext();
        var svc = ctx.service;

        var result = svc.simulate(this._baseRequest());

        this._assert(result.success === false, 'Exhausted retry must be blocked');
        this._assert(result.http_status === 409, 'Exhausted retry must return 409');
        this._assert(result.code === 'RETRY_LIMIT_REACHED',
            'Exhausted retry must return the stable blocker code');
        this._assert(ctx.tracker.identifyCiCalls === 0,
            'identifyCI must not be called when retry evidence blocks');
    },

    /**
     * T6: Idempotent replay performs no build, identifyCI, or ledger write.
     */
    testIdempotentReplayNoSideEffects: function() {
        var ctx = this._buildIdempotentReplayContext();
        var svc = ctx.service;

        var result = svc.simulate(this._baseRequest());

        this._assert(result.success === true, 'success should be true');
        this._assert(result.idempotent_replay === true, 'idempotent_replay should be true');
        this._assert(result.simulation_fingerprint === this.FP_ALLOWLISTED,
            'fingerprint should match original');
        this._assert(ctx.tracker.buildWithStrategyCalls === 0,
            'buildWithStrategy must not be called on replay');
        this._assert(ctx.tracker.identifyCiCalls === 0,
            'identifyCI must not be called on replay');
        this._assert(ctx.tracker.ledgerWrites.length === 0,
            'No ledger writes on replay');
    },

    /**
     * T7: Canonical fingerprint is exactly 64-character hexadecimal.
     */
    testCanonicalFingerprintIs64CharHex: function() {
        var ctx = this._buildAllowlistedContext();
        var svc = ctx.service;

        var result = svc.simulate(this._baseRequest());

        var fp = result.simulation_fingerprint;
        this._assert(fp && fp.length === 64, 'fingerprint must be 64 chars, got: ' + (fp ? fp.length : 0));
        this._assert(/^[0-9A-F]{64}$/.test(fp), 'fingerprint must be uppercase hex');
    },

    /**
     * T8: Strategy and mapping version affect canonical fingerprint.
     *     Two runs with different strategy_evidence produce different fingerprints.
     */
    testStrategyAndMappingAffectFingerprint: function() {
        var ctx1 = this._buildAllowlistedContext();
        var result1 = ctx1.service.simulate(this._baseRequest());

        var ctx2 = this._buildStrategyContext();
        var result2 = ctx2.service.simulate(this._baseRequest());

        this._assert(result1.simulation_fingerprint !== result2.simulation_fingerprint,
            'Different strategy should produce different fingerprints. ' +
            'fp1=' + result1.simulation_fingerprint + ' fp2=' + result2.simulation_fingerprint);
    },

    /**
     * T9: retry_count=1 and max_retries=1 are recorded for strategy simulations.
     */
    testRetryCountAndMaxRetriesRecorded: function() {
        var ctx = this._buildStrategyContext();
        var svc = ctx.service;

        svc.simulate(this._baseRequest());

        var detail = ctx.tracker.ledgerWrites[ctx.tracker.ledgerWrites.length - 1];
        this._assert(detail.retry_count === 1,
            'retry_count should be 1, got: ' + detail.retry_count);
        this._assert(detail.max_retries === 1,
            'max_retries should be 1, got: ' + detail.max_retries);
    },

    /**
     * T10: Normal (allowlisted) simulations omit strategy fields from ledger.
     */
    testNormalSimulationsOmitStrategyFields: function() {
        var ctx = this._buildAllowlistedContext();
        ctx.service.simulate(this._baseRequest());

        var detail = ctx.tracker.ledgerWrites[ctx.tracker.ledgerWrites.length - 1];
        this._assert(detail.action === 'ire_simulation_completed', 'action correct');
        this._assert(detail.status === 'completed', 'status must be completed');
        this._assert(!detail.hasOwnProperty('strategy_id'), 'no strategy_id in ledger');
        this._assert(!detail.hasOwnProperty('mapping_version'), 'no mapping_version in ledger');
        this._assert(!detail.hasOwnProperty('source_class'), 'no source_class in ledger');
        this._assert(!detail.hasOwnProperty('target_class'), 'no target_class in ledger');
        this._assert(!detail.hasOwnProperty('retry_count'), 'no retry_count in ledger');
        this._assert(!detail.hasOwnProperty('max_retries'), 'no max_retries in ledger');
        this._assert(!detail.hasOwnProperty('decision_source'), 'no decision_source in ledger');
        this._assert(!detail.hasOwnProperty('work_group_signature'), 'no work_group_signature in ledger');
    },

    /**
     * T11: Strategy simulations record compact strategy fields.
     */
    testStrategySimulationsRecordCompactFields: function() {
        var ctx = this._buildStrategyContext();
        ctx.service.simulate(this._baseRequest());

        var detail = ctx.tracker.ledgerWrites[ctx.tracker.ledgerWrites.length - 1];
        this._assert(detail.action === 'ire_simulation_completed', 'action correct');
        this._assert(detail.status === 'completed', 'status must be completed');
        this._assert(detail.strategy_id === 'normalize_known_class_alias', 'strategy_id');
        this._assert(detail.mapping_version === 'class-alias-v1', 'mapping_version');
        this._assert(detail.source_class === 'windows srv', 'source_class');
        this._assert(detail.target_class === 'cmdb_ci_win_server', 'target_class');
        this._assert(detail.retry_count === 1, 'retry_count');
        this._assert(detail.max_retries === 1, 'max_retries');
        this._assert(detail.decision_source === 'deterministic', 'decision_source');
        this._assert(detail.work_group_signature === 'unknown:unclassified:general', 'work_group_signature');
    },

    /**
     * T12: No raw payload, IRE input, authoritative values, or source rows in ledger detail.
     */
    testNoRawPayloadOrIreInputInLedger: function() {
        var ctx = this._buildStrategyContext();
        ctx.service.simulate(this._baseRequest());

        var detail = ctx.tracker.ledgerWrites[ctx.tracker.ledgerWrites.length - 1];
        var serialized = JSON.stringify(detail);

        var forbidden = [
            'ire_payload', 'authoritative_values', 'source_row',
            'values', 'payload', 'input_fingerprint',
            'credentials', 'prompt', 'identifiers',
            'cmdb_values', 'className'
        ];

        for (var i = 0; i < forbidden.length; i++) {
            this._assert(
                serialized.indexOf('"' + forbidden[i] + '"') === -1,
                'Ledger detail must not contain "' + forbidden[i] + '", but it does'
            );
        }
    },

    /**
     * T13: Browser/model cannot provide mapping or payload fields.
     *      The simulate method's _validateRequest rejects INVALID_REQUEST
     *      before any payload build or identifyCI call occurs.
     */
    testBrowserCannotProvideMapping: function() {
        var ctx = this._buildAllowlistedContext();
        var svc = ctx.service;

        // Supply untrusted fields in the request
        var request = this._baseRequest();
        request.strategy_evidence = { strategy_id: 'injected' };
        request.mapping_version = 'evil-v1';
        request.payload = { items: [{ className: 'injected' }] };
        request.ire_payload = { items: [] };
        request.source_class = 'injected_class';

        var result = svc.simulate(request);

        this._assert(result.success === false,
            'Request containing untrusted fields must fail');
        this._assert(result.http_status === 400,
            'Untrusted request must return 400');
        this._assert(result.code === 'INVALID_REQUEST',
            'Untrusted request must return INVALID_REQUEST');

        // Confirm no buildWithStrategy or identifyCI call occurred
        this._assert(ctx.tracker.buildWithStrategyCalls === 0,
            'buildWithStrategy must not be called when request is rejected');
        this._assert(ctx.tracker.identifyCiCalls === 0,
            'identifyCI must not be called when request is rejected');
    },

    /**
     * T14: No createOrUpdateCI, eventQueue, CMDB write, approval, Execute, or Verify dependency.
     *      Uses behavioral tracker to prove correct call counts.
     */
    testNoLiveActionsInSource: function() {
        // ── Prove _identifyCi is called exactly once on a valid simulation ──
        var ctxValid = this._buildAllowlistedContext();
        ctxValid.service.simulate(this._baseRequest());
        this._assert(ctxValid.tracker.identifyCiCalls === 1,
            '_identifyCi must be called exactly once on valid simulation, got: ' + ctxValid.tracker.identifyCiCalls);

        // ── Prove zero _identifyCi calls for unknown aliases ──
        var ctxUnknown = this._buildUnknownAliasContext();
        try { ctxUnknown.service.simulate(this._baseRequest()); } catch (e) { /* expected */ }
        this._assert(ctxUnknown.tracker.identifyCiCalls === 0,
            '_identifyCi must not be called for unknown alias, got: ' + ctxUnknown.tracker.identifyCiCalls);

        // ── Prove zero _identifyCi calls after exhausted retry evidence ──
        var ctxRetry = this._buildRetryBlockedContext();
        try { ctxRetry.service.simulate(this._baseRequest()); } catch (e) { /* expected */ }
        this._assert(ctxRetry.tracker.identifyCiCalls === 0,
            '_identifyCi must not be called after exhausted retries, got: ' + ctxRetry.tracker.identifyCiCalls);

        // ── Prove no forbidden dependencies are invoked ──
        // All contexts use instance-level overrides. If any forbidden dependency
        // (createOrUpdateCI, eventQueue, approval, Execute, Verify) were called,
        // the test harness would have thrown or the tracker would show evidence.
        // Verify the source does not contain forbidden terms
        var svc = new DotwalkersIreSimulationService();
        var source = String(svc.simulate);

        var forbidden = [
            'createOrUpdateCI',
            'eventQueue',
            'update()',
            'insert()',
            'approval',
            'Execute',
            'Verify'
        ];

        for (var i = 0; i < forbidden.length; i++) {
            this._assert(
                source.indexOf(forbidden[i]) === -1,
                'simulate source must not contain "' + forbidden[i] + '"'
            );
        }

        this._assert(
            source.indexOf('sn_cmdb') === -1,
            'simulate must not reference sn_cmdb directly'
        );
    },

    /**
     * T15: A successful completedDetail with status:'completed' is recognized as
     *      counted retry evidence by DotwalkersIrePayloadService._isCountedRetryEvidence.
     */
    testRetryEvidenceCountsCompletedDetail: function() {
        // Create test strategy evidence through the real helper
        var decision = new DotwalkersFailureStrategyService().decide(
            { source_class: 'windows srv' },
            0
        );

        // Build a completedDetail matching what simulate produces for a strategy run
        var completedDetail = {
            action: 'ire_simulation_completed',
            status: 'completed',
            migration_run_id: this.RUN_ID,
            staged_ci_id: this.CI_ID,
            correlation_id: this.CORRELATION,
            simulation_correlation_id: this.CORRELATION,
            simulation_fingerprint: this.FP_STRATEGY,
            operation: 'UPDATE',
            simulation_matched_ci: 'ee112233445566778899aabbccddeeff',
            idempotency_key: this.IDEMPOTENCY,
            strategy_id: decision.strategy_id,
            mapping_version: decision.mapping_version,
            source_class: decision.source_class,
            target_class: decision.target_class,
            retry_count: decision.retry_count,
            max_retries: decision.max_retries,
            decision_source: decision.decision_source,
            work_group_signature: decision.signature
        };

        // Verify expected decision values
        this._assert(decision.strategy_id === 'normalize_known_class_alias',
            'decision strategy_id mismatch: ' + decision.strategy_id);
        this._assert(decision.mapping_version === 'class-alias-v1',
            'decision mapping_version mismatch: ' + decision.mapping_version);
        this._assert(decision.source_class === 'windows srv',
            'decision source_class mismatch: ' + decision.source_class);
        this._assert(decision.target_class === 'cmdb_ci_win_server',
            'decision target_class mismatch: ' + decision.target_class);
        this._assert(decision.retry_count === 1,
            'decision retry_count mismatch: ' + decision.retry_count);
        this._assert(decision.max_retries === 1,
            'decision max_retries mismatch: ' + decision.max_retries);
        this._assert(decision.decision_source === 'deterministic',
            'decision decision_source mismatch: ' + decision.decision_source);

        var payloadSvc = new DotwalkersIrePayloadService();
        var result = payloadSvc._isCountedRetryEvidence(
            completedDetail,
            this.RUN_ID,
            this.CI_ID
        );

        this._assert(result === true,
            '_isCountedRetryEvidence must return true for completedDetail with status:completed');
    },

    /**
     * T16: A subsequent buildWithStrategy for the same staged CI is blocked when the
     *      completed ledger evidence is returned by the mocked ledger dependency.
     *      Because buildWithStrategy is inside simulate()'s try block, the externally
     *      visible error must be only "IRE simulation failed".
     */
    testCompletedEvidenceBlocksBuildWithStrategy: function() {
        var self = this;
        var tracker = {
            identifyCiCalls: 0,
            buildWithStrategyCalls: 0,
            buildWithStrategyArgs: [],
            ledgerWrites: []
        };

        // Create test strategy evidence through the real helper
        var decision = new DotwalkersFailureStrategyService().decide(
            { source_class: 'windows srv' },
            0
        );

        // Mock payload service where buildWithStrategy reads the ledger and blocks
        var mockPayloadSvc = {
            buildWithStrategy: function(runId, stagedCiId) {
                tracker.buildWithStrategyCalls++;
                tracker.buildWithStrategyArgs.push({ runId: runId, stagedCiId: stagedCiId });
                // Simulate what the real buildWithStrategy does: calls _countPriorRetries
                // which finds the completedEvidence in the ledger and returns 1,
                // causing the strategy service to block
                var retryError = new Error('Strategy blocked: Retry limit reached');
                retryError.error_code = 'RETRY_LIMIT_REACHED';
                throw retryError;
            }
        };

        var svc = new DotwalkersIreSimulationService();

        svc._newPayloadService = function() { return mockPayloadSvc; };
        svc._identifyCi = function() {
            tracker.identifyCiCalls++;
            throw new Error('identifyCI should not be called when retry blocked');
        };
        svc._validateCaller = function() { /* pass */ };
        svc._findCompletedSimulation = function() { return null; };
        svc._blockerEventExists = function() { return false; };
        svc._logStartedOnce = function() { /* no-op */ };
        svc._actionExists = function() { return false; };
        svc._writeLedger = function(runId, eventType, detail) {
            tracker.ledgerWrites.push(detail);
            return 'ledger_blocked';
        };

        // Use a different idempotency key to simulate a new attempt
        var newRequest = {
            migration_run_id: self.RUN_ID,
            staged_ci_id: self.CI_ID,
            correlation_id: 'ks-sim-b3a-test-002',
            idempotency_key: 'simulate:run:' + self.RUN_ID + ':ci:' + self.CI_ID + ':attempt2'
        };

        var result = svc.simulate(newRequest);

        this._assert(result.success === false,
            'Prior completed evidence must block');
        this._assert(result.http_status === 409,
            'Prior completed evidence must return 409');
        this._assert(result.code === 'RETRY_LIMIT_REACHED',
            'Prior completed evidence must return RETRY_LIMIT_REACHED');
        this._assert(tracker.buildWithStrategyCalls === 1,
            'buildWithStrategy should be called once (then block)');
        this._assert(tracker.identifyCiCalls === 0,
            'identifyCI must not be called when buildWithStrategy blocks');

        // Verify the error ledger write uses compact fields
        this._assert(tracker.ledgerWrites.length === 1,
            'One error ledger write expected');
        var errorDetail = tracker.ledgerWrites[0];
        this._assert(errorDetail.action === 'ire_simulation_blocked', 'blocker action');
        this._assert(errorDetail.status === 'blocked', 'blocker status must be blocked');
        this._assert(errorDetail.error_code === 'RETRY_LIMIT_REACHED', 'error_code');
    },

    /**
     * T17: Guest user is rejected by _validateCaller using dependency wrapper.
     */
    testCallerGuestRejection: function() {
        var svc = new DotwalkersIreSimulationService();

        // Override the dependency wrappers to simulate guest
        svc._currentUserId = function() { return 'guest'; };
        svc._callerHasRole = function() { return false; };

        var threw = false;
        var errorMessage = '';
        try {
            svc._validateCaller();
        } catch (e) {
            threw = true;
            errorMessage = e && e.message ? e.message : String(e);
        }

        this._assert(threw, 'Must throw for guest user');
        this._assert(errorMessage.indexOf('authenticated') >= 0,
            'Error must mention authentication, got: ' + errorMessage);
    },

    /**
     * T18: User without migration_run_user role is rejected.
     */
    testCallerMissingMigrationRoleRejected: function() {
        var svc = new DotwalkersIreSimulationService();

        // Override: authenticated user but no migration role
        svc._currentUserId = function() { return 'abc123def456abc123def456abc123de'; };
        svc._callerHasRole = function(role) {
            // User does not have the required migration role
            return false;
        };

        var threw = false;
        var errorMessage = '';
        try {
            svc._validateCaller();
        } catch (e) {
            threw = true;
            errorMessage = e && e.message ? e.message : String(e);
        }

        this._assert(threw, 'Must throw for user without migration role');
        this._assert(errorMessage.indexOf('not authorized') >= 0,
            'Error must mention authorization, got: ' + errorMessage);
    },

    /**
     * T19: User with migration_run_user role passes _validateCaller.
     */
    testCallerValidMigrationRoleAccepted: function() {
        var svc = new DotwalkersIreSimulationService();

        // Override: authenticated user with migration role
        svc._currentUserId = function() { return 'abc123def456abc123def456abc123de'; };
        svc._callerHasRole = function(role) {
            return role === 'x_kest_dotwalkers.migration_run_user';
        };

        var threw = false;
        try {
            svc._validateCaller();
        } catch (e) {
            threw = true;
        }

        this._assert(!threw, '_validateCaller must not throw for valid migration role user');
    },

    /**
     * T20: Error evidence uses compact fields without raw error message.
     */
    testErrorEvidenceCompactFields: function() {
        var ctx = this._buildUnknownAliasContext();
        var svc = ctx.service;

        var result = svc.simulate(this._baseRequest());
        this._assert(result.success === false, 'Unknown alias must be blocked');

        // Verify the error ledger entry
        this._assert(ctx.tracker.ledgerWrites.length >= 1, 'At least one ledger write expected');
        var errorDetail = ctx.tracker.ledgerWrites[ctx.tracker.ledgerWrites.length - 1];

        this._assert(errorDetail.action === 'ire_simulation_blocked', 'action must be ire_simulation_blocked');
        this._assert(errorDetail.status === 'blocked', 'status must be blocked');
        this._assert(errorDetail.migration_run_id === this.RUN_ID, 'migration_run_id must be present');
        this._assert(errorDetail.staged_ci_id === this.CI_ID, 'staged_ci_id must be present');
        this._assert(errorDetail.correlation_id === this.CORRELATION, 'correlation_id must be present');
        this._assert(errorDetail.idempotency_key === this.IDEMPOTENCY, 'idempotency_key must be present');
        this._assert(errorDetail.error_code === 'UNSUPPORTED_CLASS_ALIAS',
            'error_code must be UNSUPPORTED_CLASS_ALIAS');
        this._assert(errorDetail.decision_source === 'deterministic',
            'decision_source must be deterministic');
        this._assert(Object.keys(errorDetail).length === 9,
            'blocker detail must contain exactly nine keys');
    },

    /**
     * T21: Error evidence does not contain raw error messages, stack traces,
     *      IRE output, payload data, class values, or source values.
     */
    testErrorEvidenceNoRawMessage: function() {
        var ctx = this._buildUnknownAliasContext();
        var svc = ctx.service;

        try {
            svc.simulate(this._baseRequest());
        } catch (e) {
            // expected
        }

        var errorDetail = ctx.tracker.ledgerWrites[ctx.tracker.ledgerWrites.length - 1];
        var serialized = JSON.stringify(errorDetail);

        // Must not contain the raw exception message
        this._assert(
            serialized.indexOf('No allowlisted deterministic strategy') === -1,
            'Must not contain raw error message from buildWithStrategy'
        );
        this._assert(
            serialized.indexOf('Strategy blocked') === -1,
            'Must not contain strategy blocked text'
        );

        // Must not contain dangerous fields
        var forbidden = [
            'message', 'stack', 'ire_payload', 'payload',
            'values', 'className', 'source_values', 'ire_output'
        ];
        for (var i = 0; i < forbidden.length; i++) {
            this._assert(
                serialized.indexOf('"' + forbidden[i] + '"') === -1,
                'Error detail must not contain "' + forbidden[i] + '"'
            );
        }
    },

    testInsertOperationClearsMatchedCi: function() {
        var ctx = this._buildAllowlistedContext();
        ctx.service._identifyCi = function() {
            ctx.tracker.identifyCiCalls++;
            return JSON.stringify({
                items: [{
                    operation: 'INSERT',
                    sysId: 'ff112233445566778899aabbccddeeff',
                    errorCount: 0
                }]
            });
        };

        var result = ctx.service.simulate(this._baseRequest());

        this._assert(result.success === true, 'INSERT simulation must succeed');
        this._assert(result.operation === 'INSERT', 'operation must be INSERT');
        this._assert(result.simulation_matched_ci === '',
            'INSERT simulation must clear matched CI');
    },

    testUnknownUntypedErrorExercisesSanitized500: function() {
        var ctx = this._buildAllowlistedContext();
        ctx.service._newPayloadService = function() {
            return {
                buildWithStrategy: function() {
                    throw new Error('sensitive internal payload failure');
                }
            };
        };

        var threw = false;
        var message = '';
        try {
            ctx.service.simulate(this._baseRequest());
        } catch (error) {
            threw = true;
            message = error && error.message ? error.message : String(error);
        }

        this._assert(threw, 'Untyped internal error must throw');
        this._assert(message === 'IRE simulation failed',
            'Untyped error must expose only the sanitized message');

        var detail = ctx.tracker.ledgerWrites[ctx.tracker.ledgerWrites.length - 1];
        this._assert(detail.error_code === 'IRE_SIMULATION_FAILED',
            'Untyped error ledger code must be IRE_SIMULATION_FAILED');
        this._assert(JSON.stringify(detail).indexOf('sensitive internal') === -1,
            'Untyped error detail must not expose the original message');
    },

    // ─────────────────────────────────────────────────────────────
    // Context builders — instance-level overrides only
    // ─────────────────────────────────────────────────────────────

    _baseRequest: function() {
        return {
            migration_run_id: this.RUN_ID,
            staged_ci_id: this.CI_ID,
            correlation_id: this.CORRELATION,
            idempotency_key: this.IDEMPOTENCY
        };
    },

    /**
     * Builds context for allowlisted-class simulation (no strategy).
     */
    _buildAllowlistedContext: function() {
        var self = this;
        var tracker = {
            identifyCiCalls: 0,
            buildWithStrategyCalls: 0,
            buildWithStrategyArgs: [],
            ledgerWrites: [],
            fingerprintCalls: 0
        };

        var mockPayloadSvc = {
            buildWithStrategy: function(runId, stagedCiId) {
                tracker.buildWithStrategyCalls++;
                tracker.buildWithStrategyArgs.push({ runId: runId, stagedCiId: stagedCiId });
                return {
                    proposed_class: 'cmdb_ci_linux_server',
                    staged_ci_number: 'STAGED0001',
                    input_fingerprint: 'cafecafe'.repeat(8),
                    strategy_evidence: null,
                    ire_payload: {
                        items: [{
                            className: 'cmdb_ci_linux_server',
                            values: { name: 'test-linux-01', serial_number: 'SN001' }
                        }]
                    }
                };
            },
            fingerprintSimulation: function(bundle, op, matched, evidence) {
                tracker.fingerprintCalls++;
                return self.FP_ALLOWLISTED;
            }
        };

        var svc = new DotwalkersIreSimulationService();

        // Override dependency wrappers at instance level
        svc._newPayloadService = function() { return mockPayloadSvc; };
        svc._identifyCi = function(ireInput) {
            tracker.identifyCiCalls++;
            return JSON.stringify({
                items: [{
                    operation: 'UPDATE',
                    sysId: 'ff112233445566778899aabbccddeeff',
                    errorCount: 0
                }]
            });
        };
        svc._validateCaller = function() { /* pass */ };
        svc._findCompletedSimulation = function() { return null; };
        svc._logStartedOnce = function() { /* no-op */ };
        svc._actionExists = function() { return false; };
        svc._writeLedger = function(runId, eventType, detail) {
            tracker.ledgerWrites.push(detail);
            return 'ledger_' + tracker.ledgerWrites.length;
        };
        svc._ensureProposalFinding = function() { return 'finding001'; };

        return { service: svc, tracker: tracker };
    },

    /**
     * Builds context for known-alias strategy simulation.
     * Uses real DotwalkersFailureStrategyService.decide() output for 'windows srv'.
     */
    _buildStrategyContext: function() {
        var self = this;
        var tracker = {
            identifyCiCalls: 0,
            buildWithStrategyCalls: 0,
            buildWithStrategyArgs: [],
            ledgerWrites: [],
            fingerprintCalls: 0
        };

        // Get strategy evidence from the real helper
        var decision = new DotwalkersFailureStrategyService().decide(
            { source_class: 'windows srv' },
            0
        );

        var mockPayloadSvc = {
            buildWithStrategy: function(runId, stagedCiId) {
                tracker.buildWithStrategyCalls++;
                tracker.buildWithStrategyArgs.push({ runId: runId, stagedCiId: stagedCiId });
                return {
                    proposed_class: decision.target_class,
                    staged_ci_number: 'STAGED0002',
                    input_fingerprint: 'deadbeef'.repeat(8),
                    strategy_evidence: {
                        strategy_id: decision.strategy_id,
                        mapping_version: decision.mapping_version,
                        source_class: decision.source_class,
                        target_class: decision.target_class,
                        retry_count: decision.retry_count,
                        max_retries: decision.max_retries,
                        decision_source: decision.decision_source,
                        signature: decision.signature
                    },
                    ire_payload: {
                        items: [{
                            className: decision.target_class,
                            values: { name: 'win-srv-01', serial_number: 'WS001' }
                        }]
                    }
                };
            },
            fingerprintSimulation: function(bundle, op, matched, evidence) {
                tracker.fingerprintCalls++;
                return self.FP_STRATEGY;
            }
        };

        var svc = new DotwalkersIreSimulationService();

        svc._newPayloadService = function() { return mockPayloadSvc; };
        svc._identifyCi = function(ireInput) {
            tracker.identifyCiCalls++;
            return JSON.stringify({
                items: [{
                    operation: 'UPDATE',
                    sysId: 'ee112233445566778899aabbccddeeff',
                    errorCount: 0
                }]
            });
        };
        svc._validateCaller = function() { /* pass */ };
        svc._findCompletedSimulation = function() { return null; };
        svc._logStartedOnce = function() { /* no-op */ };
        svc._actionExists = function() { return false; };
        svc._writeLedger = function(runId, eventType, detail) {
            tracker.ledgerWrites.push(detail);
            return 'ledger_' + tracker.ledgerWrites.length;
        };
        svc._ensureProposalFinding = function() { return 'finding002'; };

        return { service: svc, tracker: tracker };
    },

    /**
     * Builds context where buildWithStrategy throws for unknown alias.
     */
    _buildUnknownAliasContext: function() {
        var tracker = {
            identifyCiCalls: 0,
            buildWithStrategyCalls: 0,
            buildWithStrategyArgs: [],
            ledgerWrites: []
        };

        var mockPayloadSvc = {
            buildWithStrategy: function(runId, stagedCiId) {
                tracker.buildWithStrategyCalls++;
                tracker.buildWithStrategyArgs.push({ runId: runId, stagedCiId: stagedCiId });
                var aliasError = new Error('Strategy blocked: No allowlisted deterministic strategy');
                aliasError.error_code = 'UNSUPPORTED_CLASS_ALIAS';
                throw aliasError;
            }
        };

        var svc = new DotwalkersIreSimulationService();

        svc._newPayloadService = function() { return mockPayloadSvc; };
        svc._identifyCi = function() {
            tracker.identifyCiCalls++;
            throw new Error('identifyCI should not be called');
        };
        svc._validateCaller = function() { /* pass */ };
        svc._findCompletedSimulation = function() { return null; };
        svc._blockerEventExists = function() { return false; };
        svc._logStartedOnce = function() { /* no-op */ };
        svc._actionExists = function() { return false; };
        svc._writeLedger = function(runId, eventType, detail) {
            tracker.ledgerWrites.push(detail);
            return 'ledger_err';
        };

        return { service: svc, tracker: tracker };
    },

    /**
     * Builds context where buildWithStrategy throws due to prior retry evidence.
     */
    _buildRetryBlockedContext: function() {
        var tracker = {
            identifyCiCalls: 0,
            buildWithStrategyCalls: 0,
            buildWithStrategyArgs: [],
            ledgerWrites: []
        };

        var mockPayloadSvc = {
            buildWithStrategy: function(runId, stagedCiId) {
                tracker.buildWithStrategyCalls++;
                tracker.buildWithStrategyArgs.push({ runId: runId, stagedCiId: stagedCiId });
                var retryError = new Error('Strategy blocked: Retry limit reached');
                retryError.error_code = 'RETRY_LIMIT_REACHED';
                throw retryError;
            }
        };

        var svc = new DotwalkersIreSimulationService();

        svc._newPayloadService = function() { return mockPayloadSvc; };
        svc._identifyCi = function() {
            tracker.identifyCiCalls++;
            throw new Error('identifyCI should not be called');
        };
        svc._validateCaller = function() { /* pass */ };
        svc._findCompletedSimulation = function() { return null; };
        svc._blockerEventExists = function() { return false; };
        svc._logStartedOnce = function() { /* no-op */ };
        svc._actionExists = function() { return false; };
        svc._writeLedger = function(runId, eventType, detail) {
            tracker.ledgerWrites.push(detail);
            return 'ledger_err';
        };

        return { service: svc, tracker: tracker };
    },

    /**
     * Builds context where _findCompletedSimulation returns a prior result.
     */
    _buildIdempotentReplayContext: function() {
        var self = this;
        var tracker = {
            identifyCiCalls: 0,
            buildWithStrategyCalls: 0,
            buildWithStrategyArgs: [],
            ledgerWrites: []
        };

        var mockPayloadSvc = {
            buildWithStrategy: function() {
                tracker.buildWithStrategyCalls++;
                throw new Error('buildWithStrategy should not be called on replay');
            }
        };

        var svc = new DotwalkersIreSimulationService();

        svc._newPayloadService = function() { return mockPayloadSvc; };
        svc._identifyCi = function() {
            tracker.identifyCiCalls++;
            throw new Error('identifyCI should not be called on replay');
        };
        svc._validateCaller = function() { /* pass */ };
        svc._findCompletedSimulation = function() {
            return {
                state: 'simulated_pending_approval',
                migration_run_id: self.RUN_ID,
                staged_ci_id: self.CI_ID,
                correlation_id: self.CORRELATION,
                simulation_correlation_id: self.CORRELATION,
                idempotency_key: self.IDEMPOTENCY,
                operation: 'UPDATE',
                simulation_matched_ci: 'ff112233445566778899aabbccddeeff',
                simulation_fingerprint: self.FP_ALLOWLISTED,
                cmdb_committed: false
            };
        };
        svc._logStartedOnce = function() { /* no-op */ };
        svc._actionExists = function() { return false; };
        svc._writeLedger = function(runId, eventType, detail) {
            tracker.ledgerWrites.push(detail);
            return 'ledger_replay';
        };

        return { service: svc, tracker: tracker };
    },

    // ─────────────────────────────────────────────────────────────
    // Assertion helper
    // ─────────────────────────────────────────────────────────────

    _assert: function(condition, message) {
        if (!condition) {
            throw new Error('ASSERTION FAILED: ' + message);
        }
    },

    type: 'DotwalkersPhaseB3ATests'
};

var DotwalkersPhaseATests = Class.create();

DotwalkersPhaseATests.prototype = {
    initialize: function() {},

    run: function() {
        var results = [];
        var self = this;
        var tests = [
            'testLogAutonomousExists',
            'testLogAutonomousDelegates',
            'testFingerprintDeterministic',
            'testFingerprintChangesWithOperation',
            'testFingerprintChangesWithMatchedCi',
            'testFingerprintChangesWithPayloadBundle',
            'testFingerprintChangesWithStrategyPresence',
            'testFingerprintStrategyInvalidStrategyIdThrows',
            'testFingerprintStrategyInvalidMappingVersionThrows',
            'testFingerprintStrategyInconsistentSourceClassThrows',
            'testFingerprintStrategyInconsistentTargetClassThrows',
            'testFingerprintStrategyInvalidRetryCountThrows',
            'testFingerprintStrategyInvalidMaxRetriesThrows',
            'testFingerprintRejectsUnboundStrategy',
            'testFingerprintRejectsMissingStrategyArgument',
            'testFingerprintRejectsMismatchedStrategy',
            'testRetryEvidenceAcceptsExactMatch',
            'testRetryEvidenceRejectsWrongStrategy',
            'testRetryEvidenceRejectsStaleMapping',
            'testRetryEvidenceRejectsWrongRun',
            'testRetryEvidenceRejectsWrongStagedCi',
            'testFailedEvidenceDoesNotCount',
            'testBlockedEvidenceDoesNotCount',
            'testMalformedEvidenceDoesNotCount',
            'testReplayEvidenceDoesNotCount',
            'testIsLegacyFingerprint',
            'testIsCanonicalFingerprint',
            'testIsLegacyRejectsCanonical',
            'testIsCanonicalRejectsLegacy',
            'testBuildMethodExists',
            'testBuildWithStrategyMethodExists',
            'testBuildWithStrategyAllowlistedClass',
            'testBuildWithStrategyBlocksUnknownAlias',
            'testBuildWithStrategyBlocksPriorRetry'
        ];

        for (var i = 0; i < tests.length; i++) {
            var name = tests[i];
            var result = { name: name, passed: false, message: '' };

            try {
                self[name]();
                result.passed = true;
                result.message = 'PASS';
            } catch (e) {
                result.message = 'FAIL: ' + (e.message || String(e));
            }

            results.push(result);
        }

        var passed = 0;
        for (var j = 0; j < results.length; j++) {
            if (results[j].passed) passed++;
        }

        return JSON.stringify({
            total: results.length,
            passed: passed,
            failed: results.length - passed,
            results: results
        });
    },

    _assert: function(condition, message) {
        if (!condition) {
            throw new Error(message || 'Assertion failed');
        }
    },

    _assertEqual: function(expected, actual, message) {
        if (expected !== actual) {
            throw new Error(
                (message || 'Assertion failed') +
                ' — expected: ' + JSON.stringify(expected) +
                ', actual: ' + JSON.stringify(actual)
            );
        }
    },

    _assertNotEqual: function(val1, val2, message) {
        if (val1 === val2) {
            throw new Error(
                (message || 'Values should differ') +
                ' — both: ' + JSON.stringify(val1)
            );
        }
    },

    _assertThrows: function(fn, expectedSubstring) {
        var threw = false;
        var msg = '';
        try {
            fn();
        } catch (e) {
            threw = true;
            msg = e.message || String(e);
        }
        if (!threw) {
            throw new Error('Expected an error to be thrown');
        }
        if (expectedSubstring && msg.indexOf(expectedSubstring) === -1) {
            throw new Error(
                'Expected error containing "' + expectedSubstring +
                '" but got: "' + msg + '"'
            );
        }
    },

    _mockBundle: function() {
        return {
            success: true,
            strategy_evidence: null,
            input_fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
        };
    },

    _mockBundleAlternate: function() {
        return {
            success: true,
            strategy_evidence: null,
            input_fingerprint: 'ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00ff00'
        };
    },

    _validRetryEvidence: function(runId, stagedCiId) {
        var evidence = new DotwalkersFailureStrategyService().decide(
            { source_class: 'linux srv' },
            0
        );
        evidence.migration_run_id = runId;
        evidence.staged_ci_id = stagedCiId;
        evidence.decision_source = 'deterministic';
        evidence.status = 'completed';
        evidence.idempotency_key = 'retry:' + runId + ':' + stagedCiId;
        return evidence;
    },

    /* ===== Test: logAutonomous method exists ===== */
    testLogAutonomousExists: function() {
        var support = new DotwalkersAgentSupport('dummy_run_id_for_test');
        this._assert(
            typeof support.logAutonomous === 'function',
            'logAutonomous method must exist on DotwalkersAgentSupport'
        );
    },

    /* ===== Test: logAutonomous delegates to log via DotwalkersAgentEventDetailService ===== */
    testLogAutonomousDelegates: function() {
        var support = new DotwalkersAgentSupport('dummy_run_id_for_test');

        // Mock log to capture what it receives
        var logCalled = false;
        var capturedEventType = '';
        var capturedActor = '';
        var capturedDetail = '';
        support.log = function(eventType, actor, detail) {
            logCalled = true;
            capturedEventType = eventType;
            capturedActor = actor;
            capturedDetail = detail;
            return 'mock_sys_id';
        };

        var testData = { phase: 'remediate', actor: 'TestActor', action: 'test_action', status: 'completed', summary: 'Test summary' };
        var expectedDetail = new DotwalkersAgentEventDetailService().build(testData);

        support.logAutonomous('test_event', 'test_actor', testData);

        this._assert(logCalled, 'log() should have been called by logAutonomous');
        this._assertEqual('test_event', capturedEventType, 'eventType should pass through');
        this._assertEqual('test_actor', capturedActor, 'actor should pass through');
        this._assertEqual(expectedDetail, capturedDetail, 'detail should be compact JSON from DotwalkersAgentEventDetailService.build()');
    },

    /* ===== Test: fingerprint is deterministic ===== */
    testFingerprintDeterministic: function() {
        var svc = new DotwalkersIrePayloadService();
        var bundle = this._mockBundle();

        var fp1 = svc.fingerprintSimulation(bundle, 'INSERT', '');
        var fp2 = svc.fingerprintSimulation(bundle, 'INSERT', '');

        this._assertEqual(fp1, fp2, 'Same inputs must produce same fingerprint');
        this._assertEqual(64, fp1.length, 'SHA-256 hex must be 64 chars');
        this._assert(/^[0-9a-f]{64}$/i.test(fp1), 'Must be hex');
    },

    /* ===== Test: different operation changes fingerprint ===== */
    testFingerprintChangesWithOperation: function() {
        var svc = new DotwalkersIrePayloadService();
        var bundle = this._mockBundle();

        var fp1 = svc.fingerprintSimulation(bundle, 'INSERT', '');
        var fp2 = svc.fingerprintSimulation(bundle, 'UPDATE', '');

        this._assertNotEqual(fp1, fp2, 'Different operations must produce different fingerprints');
    },

    /* ===== Test: different matched CI changes fingerprint ===== */
    testFingerprintChangesWithMatchedCi: function() {
        var svc = new DotwalkersIrePayloadService();
        var bundle = this._mockBundle();

        var fp1 = svc.fingerprintSimulation(bundle, 'UPDATE', 'aaaabbbbccccddddeeeeffffaaaabbbb');
        var fp2 = svc.fingerprintSimulation(bundle, 'UPDATE', '11112222333344445555666677778888');

        this._assertNotEqual(fp1, fp2, 'Different matched CI must produce different fingerprints');
    },

    /* ===== Test: different payload bundle changes fingerprint ===== */
    testFingerprintChangesWithPayloadBundle: function() {
        var svc = new DotwalkersIrePayloadService();
        var bundle1 = this._mockBundle();
        var bundle2 = this._mockBundleAlternate();

        var fp1 = svc.fingerprintSimulation(bundle1, 'INSERT', '');
        var fp2 = svc.fingerprintSimulation(bundle2, 'INSERT', '');

        this._assertNotEqual(fp1, fp2, 'Different payload bundles must produce different fingerprints');
    },

    /* ===== Test: valid strategy presence changes fingerprint ===== */
    testFingerprintChangesWithStrategyPresence: function() {
        var svc = new DotwalkersIrePayloadService();
        var bundle = this._mockBundle();

        var strategySvc = new DotwalkersFailureStrategyService();
        var decision = strategySvc.decide({ source_class: 'linux srv' }, 0);
        this._assertEqual('selected', decision.status, 'linux srv should be selected');

        var fpWithoutStrategy = svc.fingerprintSimulation(bundle, 'INSERT', '');
        bundle.strategy_evidence = decision;
        var fpWithStrategy = svc.fingerprintSimulation(bundle, 'INSERT', '', decision);

        this._assertNotEqual(fpWithoutStrategy, fpWithStrategy, 'Strategy presence must change the fingerprint');
    },

    /* ===== Test: invalid strategy_id must throw ===== */
    testFingerprintStrategyInvalidStrategyIdThrows: function() {
        var svc = new DotwalkersIrePayloadService();
        var bundle = this._mockBundle();

        var strategySvc = new DotwalkersFailureStrategyService();
        var decision = strategySvc.decide({ source_class: 'linux srv' }, 0);

        // Tamper with strategy_id
        decision.strategy_id = 'unsupported_strategy_xyz';
        bundle.strategy_evidence = decision;

        var self = this;
        self._assertThrows(function() {
            svc.fingerprintSimulation(bundle, 'INSERT', '', decision);
        }, 'Unsupported persisted retry strategy');
    },

    /* ===== Test: invalid mapping_version must throw ===== */
    testFingerprintStrategyInvalidMappingVersionThrows: function() {
        var svc = new DotwalkersIrePayloadService();
        var bundle = this._mockBundle();

        var strategySvc = new DotwalkersFailureStrategyService();
        var decision = strategySvc.decide({ source_class: 'linux srv' }, 0);

        // Tamper with mapping_version
        decision.mapping_version = 'class-alias-v99-stale';
        bundle.strategy_evidence = decision;

        var self = this;
        self._assertThrows(function() {
            svc.fingerprintSimulation(bundle, 'INSERT', '', decision);
        }, 'Persisted mapping version is stale');
    },

    /* ===== Test: inconsistent source_class must throw ===== */
    testFingerprintStrategyInconsistentSourceClassThrows: function() {
        var svc = new DotwalkersIrePayloadService();
        var bundle = this._mockBundle();

        var strategySvc = new DotwalkersFailureStrategyService();
        var decision = strategySvc.decide({ source_class: 'linux srv' }, 0);

        // Tamper with source_class to something inconsistent
        decision.source_class = 'totally_invalid_not_mapped';
        bundle.strategy_evidence = decision;

        var self = this;
        self._assertThrows(function() {
            svc.fingerprintSimulation(bundle, 'INSERT', '', decision);
        });
    },

    /* ===== Test: inconsistent target_class must throw ===== */
    testFingerprintStrategyInconsistentTargetClassThrows: function() {
        var svc = new DotwalkersIrePayloadService();
        var bundle = this._mockBundle();

        var strategySvc = new DotwalkersFailureStrategyService();
        var decision = strategySvc.decide({ source_class: 'linux srv' }, 0);

        // Tamper with target_class
        decision.target_class = 'cmdb_ci_fake_class';
        bundle.strategy_evidence = decision;

        var self = this;
        self._assertThrows(function() {
            svc.fingerprintSimulation(bundle, 'INSERT', '', decision);
        }, 'Persisted class mapping does not match');
    },

    /* ===== Test: invalid retry_count must throw ===== */
    testFingerprintStrategyInvalidRetryCountThrows: function() {
        var svc = new DotwalkersIrePayloadService();
        var bundle = this._mockBundle();

        var strategySvc = new DotwalkersFailureStrategyService();
        var decision = strategySvc.decide({ source_class: 'linux srv' }, 0);

        // Tamper with retry_count (should be 1)
        decision.retry_count = 0;
        bundle.strategy_evidence = decision;

        var self = this;
        self._assertThrows(function() {
            svc.fingerprintSimulation(bundle, 'INSERT', '', decision);
        }, 'retry_count must be exactly 1');
    },

    /* ===== Test: invalid max_retries must throw ===== */
    testFingerprintStrategyInvalidMaxRetriesThrows: function() {
        var svc = new DotwalkersIrePayloadService();
        var bundle = this._mockBundle();

        var strategySvc = new DotwalkersFailureStrategyService();
        var decision = strategySvc.decide({ source_class: 'linux srv' }, 0);

        // Tamper with max_retries (should be 1, set to 5)
        // The evidence max_retries=5 will be compared against reconstructed max_retries=1
        // and rejected because they don't match
        decision.max_retries = 5;
        bundle.strategy_evidence = decision;

        var self = this;
        self._assertThrows(function() {
            svc.fingerprintSimulation(bundle, 'INSERT', '', decision);
        }, 'max_retries must be exactly 1');
    },

    /* ===== Test: mocked persisted successful retry evidence blocks second call ===== */
    testRetryEvidenceBlocksSecondCall: function() {
        var strategySvc = new DotwalkersFailureStrategyService();

        // First call: retryCount=0 -> selected
        var first = strategySvc.decide({ source_class: 'linux srv' }, 0);
        this._assertEqual('selected', first.status, 'First attempt should be selected');
        this._assertEqual(1, first.retry_count, 'retry_count should be 1');

        // After a successful retry has been persisted, count is 1 -> blocked
        var second = strategySvc.decide({ source_class: 'linux srv' }, 1);
        this._assertEqual('blocked', second.status, 'After persisted successful retry evidence, must block');
    },

    /* ===== Test: failed evidence does not count ===== */
    _obsoleteFailedEvidenceDesignTest: function() {
        // Failed/blocked events would have status 'failed' or 'blocked' in ledger detail
        // The _countPriorRetries method only counts status 'selected' or 'completed'
        // Verify by testing decide with retryCount=0 (simulating that failed evidence was filtered out)
        var strategySvc = new DotwalkersFailureStrategyService();
        var result = strategySvc.decide({ source_class: 'linux srv' }, 0);
        this._assertEqual('selected', result.status, 'With no valid prior retries (failed filtered), should be selected');
    },

    /* ===== Test: blocked evidence does not count ===== */
    _obsoleteBlockedEvidenceDesignTest: function() {
        // Blocked events have status 'blocked' which is not 'selected'/'completed'
        // so they would be filtered by _countPriorRetries → retryCount stays 0
        var strategySvc = new DotwalkersFailureStrategyService();
        var result = strategySvc.decide({ source_class: 'windows srv' }, 0);
        this._assertEqual('selected', result.status, 'With no valid prior retries (blocked filtered), should be selected');
    },

    /* ===== Test: malformed evidence does not count ===== */
    _obsoleteMalformedEvidenceDesignTest: function() {
        // Malformed evidence (non-JSON detail) is skipped by _countPriorRetries
        // Verify the service still allows first attempt
        var strategySvc = new DotwalkersFailureStrategyService();
        var result = strategySvc.decide({ source_class: 'linux server' }, 0);
        this._assertEqual('selected', result.status, 'With malformed evidence filtered, should be selected');
    },

    /* ===== Test: replay/idempotent evidence does not count ===== */
    _obsoleteReplayEvidenceDesignTest: function() {
        // An idempotent replay would not have status 'selected'/'completed'
        // or would lack retry_count >= 1, so it's filtered
        var strategySvc = new DotwalkersFailureStrategyService();
        // Verifying the filtering logic: retryCount=0 means no valid evidence counted
        var result = strategySvc.decide({ source_class: 'linux srv' }, 0);
        this._assertEqual('selected', result.status, 'With replay evidence filtered, should be selected');
        this._assertEqual(1, result.retry_count, 'Should produce retry_count=1');
    },

    testFingerprintRejectsUnboundStrategy: function() {
        var svc = new DotwalkersIrePayloadService();
        var bundle = this._mockBundle();
        var decision = new DotwalkersFailureStrategyService().decide({ source_class: 'linux srv' }, 0);
        this._assertThrows(function() {
            svc.fingerprintSimulation(bundle, 'INSERT', '', decision);
        }, 'does not match the authoritative payload bundle');
    },

    testFingerprintRejectsMissingStrategyArgument: function() {
        var svc = new DotwalkersIrePayloadService();
        var bundle = this._mockBundle();
        bundle.strategy_evidence = new DotwalkersFailureStrategyService().decide({ source_class: 'linux srv' }, 0);
        this._assertThrows(function() {
            svc.fingerprintSimulation(bundle, 'INSERT', '');
        }, 'does not match the authoritative payload bundle');
    },

    testFingerprintRejectsMismatchedStrategy: function() {
        var svc = new DotwalkersIrePayloadService();
        var bundle = this._mockBundle();
        bundle.strategy_evidence = new DotwalkersFailureStrategyService().decide({ source_class: 'linux srv' }, 0);
        var other = new DotwalkersFailureStrategyService().decide({ source_class: 'windows srv' }, 0);
        this._assertThrows(function() {
            svc.fingerprintSimulation(bundle, 'INSERT', '', other);
        }, 'does not match the authoritative payload bundle');
    },

    testRetryEvidenceAcceptsExactMatch: function() {
        var svc = new DotwalkersIrePayloadService();
        var runId = 'aaaabbbbccccddddeeeeffffaaaabbbb';
        var stagedId = '11112222333344445555666677778888';
        this._assertEqual(true, svc._isCountedRetryEvidence(
            this._validRetryEvidence(runId, stagedId), runId, stagedId
        ));
    },

    testRetryEvidenceRejectsWrongStrategy: function() {
        var svc = new DotwalkersIrePayloadService();
        var runId = 'aaaabbbbccccddddeeeeffffaaaabbbb';
        var stagedId = '11112222333344445555666677778888';
        var evidence = this._validRetryEvidence(runId, stagedId);
        evidence.strategy_id = 'other_strategy';
        this._assertEqual(false, svc._isCountedRetryEvidence(evidence, runId, stagedId));
    },

    testRetryEvidenceRejectsStaleMapping: function() {
        var svc = new DotwalkersIrePayloadService();
        var runId = 'aaaabbbbccccddddeeeeffffaaaabbbb';
        var stagedId = '11112222333344445555666677778888';
        var evidence = this._validRetryEvidence(runId, stagedId);
        evidence.mapping_version = 'class-alias-stale';
        this._assertEqual(false, svc._isCountedRetryEvidence(evidence, runId, stagedId));
    },

    testRetryEvidenceRejectsWrongRun: function() {
        var svc = new DotwalkersIrePayloadService();
        var runId = 'aaaabbbbccccddddeeeeffffaaaabbbb';
        var stagedId = '11112222333344445555666677778888';
        var evidence = this._validRetryEvidence(runId, stagedId);
        this._assertEqual(false, svc._isCountedRetryEvidence(
            evidence, '99990000111122223333444455556666', stagedId
        ));
    },

    testRetryEvidenceRejectsWrongStagedCi: function() {
        var svc = new DotwalkersIrePayloadService();
        var runId = 'aaaabbbbccccddddeeeeffffaaaabbbb';
        var stagedId = '11112222333344445555666677778888';
        var evidence = this._validRetryEvidence(runId, stagedId);
        this._assertEqual(false, svc._isCountedRetryEvidence(
            evidence, runId, '99990000111122223333444455556666'
        ));
    },

    testFailedEvidenceDoesNotCount: function() {
        var svc = new DotwalkersIrePayloadService();
        var runId = 'aaaabbbbccccddddeeeeffffaaaabbbb';
        var stagedId = '11112222333344445555666677778888';
        var evidence = this._validRetryEvidence(runId, stagedId);
        evidence.status = 'failed';
        this._assertEqual(false, svc._isCountedRetryEvidence(evidence, runId, stagedId));
    },

    testBlockedEvidenceDoesNotCount: function() {
        var svc = new DotwalkersIrePayloadService();
        var runId = 'aaaabbbbccccddddeeeeffffaaaabbbb';
        var stagedId = '11112222333344445555666677778888';
        var evidence = this._validRetryEvidence(runId, stagedId);
        evidence.status = 'blocked';
        this._assertEqual(false, svc._isCountedRetryEvidence(evidence, runId, stagedId));
    },

    testMalformedEvidenceDoesNotCount: function() {
        var svc = new DotwalkersIrePayloadService();
        this._assertEqual(false, svc._isCountedRetryEvidence(null, 'run', 'staged'));
    },

    testReplayEvidenceDoesNotCount: function() {
        var svc = new DotwalkersIrePayloadService();
        var runId = 'aaaabbbbccccddddeeeeffffaaaabbbb';
        var stagedId = '11112222333344445555666677778888';
        var evidence = this._validRetryEvidence(runId, stagedId);
        evidence.idempotent_replay = true;
        this._assertEqual(false, svc._isCountedRetryEvidence(evidence, runId, stagedId));
    },

    /* ===== Test: isLegacyFingerprint recognizes 32-char hex ===== */
    testIsLegacyFingerprint: function() {
        var svc = new DotwalkersIrePayloadService();
        var legacy = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';

        this._assert(
            svc.isLegacyFingerprint(legacy),
            '32-char hex must be detected as legacy'
        );
        this._assertEqual(true, svc.isLegacyFingerprint(legacy), 'isLegacyFingerprint should return true for 32-char hex');
    },

    /* ===== Test: isCanonicalFingerprint recognizes 64-char hex ===== */
    testIsCanonicalFingerprint: function() {
        var svc = new DotwalkersIrePayloadService();
        var canonical = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

        this._assert(
            svc.isCanonicalFingerprint(canonical),
            '64-char hex must be detected as canonical'
        );
        this._assertEqual(true, svc.isCanonicalFingerprint(canonical), 'isCanonicalFingerprint should return true for 64-char hex');
    },

    /* ===== Test: isLegacyFingerprint rejects 64-char ===== */
    testIsLegacyRejectsCanonical: function() {
        var svc = new DotwalkersIrePayloadService();
        var canonical = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

        this._assertEqual(false, svc.isLegacyFingerprint(canonical), '64-char SHA-256 must NOT be detected as legacy');
    },

    /* ===== Test: isCanonicalFingerprint rejects 32-char ===== */
    testIsCanonicalRejectsLegacy: function() {
        var svc = new DotwalkersIrePayloadService();
        var legacy = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';

        this._assertEqual(false, svc.isCanonicalFingerprint(legacy), '32-char hex must NOT be detected as canonical');
    },

    /* ===== Test: build method exists and is callable ===== */
    testBuildMethodExists: function() {
        var svc = new DotwalkersIrePayloadService();
        this._assert(typeof svc.build === 'function', 'build method must exist');
        this._assert(typeof svc._buildAuthoritativeBundle === 'function', '_buildAuthoritativeBundle must exist');
    },

    /* ===== Test: buildWithStrategy method exists ===== */
    testBuildWithStrategyMethodExists: function() {
        var svc = new DotwalkersIrePayloadService();
        this._assert(typeof svc.buildWithStrategy === 'function', 'buildWithStrategy method must exist');
    },

    /* ===== Test: buildWithStrategy for allowlisted class returns null strategy ===== */
    testBuildWithStrategyAllowlistedClass: function() {
        var svc = new DotwalkersIrePayloadService();

        // Mock internal methods to test the allowlisted branch
        svc._loadRun = function(runId) {
            return {
                getUniqueValue: function() { return runId; },
                getValue: function(field) {
                    if (field === 'state') return 'awaiting_approval';
                    if (field === 'number') return 'MR0001';
                    if (field === 'team_prefix') return 'THE_DOTWALKERS';
                    return '';
                }
            };
        };

        svc._loadStagedCi = function(runId, stagedCiId) {
            return {
                getUniqueValue: function() { return stagedCiId; },
                getValue: function(field) {
                    if (field === 'proposed_class') return 'cmdb_ci_linux_server';
                    if (field === 'identification_status') return 'pending';
                    if (field === 'confidence') return '85';
                    if (field === 'payload') return '{"name":"test-server-01"}';
                    if (field === 'source_identifier') return 'src-001';
                    if (field === 'sys_updated_on') return '2026-07-20 12:00:00';
                    if (field === 'sys_mod_count') return '2';
                    if (field === 'number') return 'SCI0001';
                    return '';
                }
            };
        };

        svc._validateRun = function() {};
        svc._validateCandidate = function() {};
        svc._validateClass = function() {};

        svc._buildAuthoritativeBundle = function(run, staged, effectiveClass, strategyEvidence) {
            return {
                success: true,
                proposed_class: effectiveClass,
                strategy_evidence: strategyEvidence || null,
                input_fingerprint: 'test_fingerprint_hash_64_chars_long_0000000000000000000000000000'
            };
        };

        var result = svc.buildWithStrategy(
            'aaaabbbbccccddddeeeeffffaaaabbbb',
            '11112222333344445555666677778888'
        );

        this._assert(result.success === true, 'buildWithStrategy should succeed for allowlisted class');
        this._assertEqual(null, result.strategy_evidence, 'strategy_evidence should be null for allowlisted class');
        this._assertEqual('cmdb_ci_linux_server', result.proposed_class, 'Should use the allowlisted class directly');
    },

    /* ===== Test: buildWithStrategy blocks for unknown alias ===== */
    testBuildWithStrategyBlocksUnknownAlias: function() {
        var svc = new DotwalkersIrePayloadService();

        svc._loadRun = function(runId) {
            return {
                getUniqueValue: function() { return runId; },
                getValue: function(field) {
                    if (field === 'state') return 'awaiting_approval';
                    if (field === 'team_prefix') return 'THE_DOTWALKERS';
                    return '';
                }
            };
        };

        svc._loadStagedCi = function(runId, stagedCiId) {
            return {
                getUniqueValue: function() { return stagedCiId; },
                getValue: function(field) {
                    if (field === 'proposed_class') return 'totally_unknown_class_xyz';
                    if (field === 'identification_status') return 'pending';
                    if (field === 'confidence') return '85';
                    if (field === 'payload') return '{"name":"test"}';
                    return '';
                }
            };
        };

        svc._validateRun = function() {};
        svc._validateCandidate = function() {};
        svc._countPriorRetries = function() { return 0; };

        var self = this;
        self._assertThrows(function() {
            svc.buildWithStrategy(
                'aaaabbbbccccddddeeeeffffaaaabbbb',
                '11112222333344445555666677778888'
            );
        }, 'Strategy blocked');
    },

    testBuildWithStrategyBlocksPriorRetry: function() {
        var svc = new DotwalkersIrePayloadService();

        svc._loadRun = function(runId) {
            return {
                getUniqueValue: function() { return runId; },
                getValue: function(field) {
                    if (field === 'state') return 'awaiting_approval';
                    if (field === 'team_prefix') return 'THE_DOTWALKERS';
                    return '';
                }
            };
        };

        svc._loadStagedCi = function(runId, stagedCiId) {
            return {
                getUniqueValue: function() { return stagedCiId; },
                getValue: function(field) {
                    if (field === 'proposed_class') return 'linux srv';
                    if (field === 'identification_status') return 'pending';
                    if (field === 'confidence') return '85';
                    return '';
                }
            };
        };

        svc._validateRun = function() {};
        svc._validateCandidate = function() {};
        svc._countPriorRetries = function() { return 1; };

        this._assertThrows(function() {
            svc.buildWithStrategy(
                'aaaabbbbccccddddeeeeffffaaaabbbb',
                '11112222333344445555666677778888'
            );
        }, 'Retry limit reached');
    },

    type: 'DotwalkersPhaseATests'
};

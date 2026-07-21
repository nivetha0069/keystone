var DotwalkersIreSimulationService = Class.create();

DotwalkersIreSimulationService.prototype = {

    initialize: function() {
        this.TEAM = 'THE_DOTWALKERS';

        this.TABLES = {
            run:
                'x_kest_dotwalkers_migration_run',

            stagedCi:
                'x_kest_dotwalkers_staged_ci_record',

            finding:
                'x_kest_dotwalkers_finding',

            review:
                'x_kest_dotwalkers_review_decision',

            ledger:
                'x_kest_dotwalkers_event_ledger'
        };

        this.ACTOR = 'Remediate';

        this.PROPOSAL_PREFIX =
            '[IRE remediation proposal] ';

        this.REQUIRED_ROLE =
            'x_kest_dotwalkers.migration_run_user';

        this.MARA_EVENT =
            'x_kest_dotwalkers.mara.requested';

        this.APPROVAL_FIELDS = {
            migration_run_id: true,
            staged_ci_id: true,
            finding_id: true,
            review_decision_id: true,
            correlation_id: true,
            idempotency_key: true,
            simulation_correlation_id: true,
            simulation_fingerprint: true
        };

        this.ERROR_CODE_MAP = {
            INVALID_REQUEST: { http_status: 400, message: 'Invalid simulation request' },
            UNAUTHORIZED: { http_status: 401, message: 'Authentication required' },
            FORBIDDEN: { http_status: 403, message: 'Insufficient permissions' },
            RUN_NOT_FOUND: { http_status: 404, message: 'Migration run not found' },
            STAGED_CI_NOT_FOUND: { http_status: 404, message: 'Staged CI record not found' },
            RUN_STATE_INVALID: { http_status: 409, message: 'Migration run state does not allow simulation' },
            RETRY_LIMIT_REACHED: { http_status: 409, message: 'Retry limit reached for this CI simulation' },
            CANDIDATE_REJECTED: { http_status: 422, message: 'Staged CI is not eligible for simulation' },
            CLASS_NOT_ALLOWED: { http_status: 422, message: 'CMDB class is not allowlisted' },
            CLASS_INVALID: { http_status: 422, message: 'CMDB class is invalid' },
            UNSUPPORTED_CLASS_ALIAS: { http_status: 422, message: 'No supported deterministic strategy for this class alias' }
        };

        this.BLOCKER_CODES = {
            RETRY_LIMIT_REACHED: true,
            UNSUPPORTED_CLASS_ALIAS: true
        };

        this.BLOCKER_SUMMARY_MAP = {
            RETRY_LIMIT_REACHED: 'Retry limit reached for this CI simulation',
            UNSUPPORTED_CLASS_ALIAS: 'No supported deterministic strategy for this class alias'
        };

        /*
         * Browser-submitted fields that verifyExecution rejects.
         */
        this.UNTRUSTED_FIELDS = [
            'operation', 'target_class', 'targetClass',
            'target_ci', 'targetCi', 'payload',
            'identifiers', 'cmdb_values', 'cmdbValues',
            'ire_payload', 'irePayload',
            'authoritative_payload', 'authoritativePayload',
            'values', 'class_name', 'className',
            'sys_class_name', 'sysClassName',
            'target_ci_sys_id', 'expected_class', 'expected_name',
            'proposed_class', 'source_class',
            'strategy_evidence', 'strategy_id',
            'mapping_version', 'retry_count', 'max_retries'
        ];

        /*
         * Keeps multiple ledger writes in one ServiceNow transaction
         * strictly ordered even when aggregate queries do not observe
         * the preceding uncommitted insert.
         */
        this._sequenceCache = {};
    },

    // ──────────────────────────────────────────────────────────────────
    // Overridable dependency methods (for testability)
    // ──────────────────────────────────────────────────────────────────

    _currentUserId: function() {
        return String(gs.getUserID() || '');
    },

    _callerHasRole: function(role) {
        return gs.hasRole(role);
    },

    _newRecord: function(table) {
        return new GlideRecord(table);
    },

    _newPayloadService: function() {
        return new DotwalkersIrePayloadService();
    },

    _identifyCi: function(ireInput) {
        return sn_cmdb.IdentificationEngine.identifyCI(ireInput);
    },

    _sha256: function(value) {
        return String(new GlideDigest().getSHA256Hex(String(value || ''))).toLowerCase();
    },

    _queueMaraEvent: function(runRecord, runId, approvalEventId) {
        gs.eventQueue(this.MARA_EVENT, runRecord, runId, approvalEventId);
    },

    // ──────────────────────────────────────────────────────────────────
    // Phase B1: verifyExecution — shared read-only verification method
    // ──────────────────────────────────────────────────────────────────

    /**
     * Verifies a committed IRE execution against the live CMDB state
     * using only server-derived evidence and the authoritative payload.
     *
     * @param {Object} request - identifiers only:
     *   migration_run_id, staged_ci_id, correlation_id,
     *   idempotency_key, execution_correlation_id
     * @param {Object} context - must contain { mode: 'interactive' }
     *
     * @returns {Object} structured result or structured error
     */
    verifyExecution: function(request, context) {
        // ── Context gate ──
        if (!context || typeof context !== 'object' || context.mode !== 'interactive') {
            return this._verifyError(
                403, 'FORBIDDEN',
                'Only interactive mode is supported in Phase B1',
                ['context.mode must be "interactive"'],
                'executed_pending_verification'
            );
        }

        // ── Reject untrusted browser-submitted fields ──
        if (request && typeof request === 'object') {
            var presentUntrusted = [];
            for (var u = 0; u < this.UNTRUSTED_FIELDS.length; u++) {
                if (request.hasOwnProperty(this.UNTRUSTED_FIELDS[u])) {
                    presentUntrusted.push(this.UNTRUSTED_FIELDS[u]);
                }
            }
            if (presentUntrusted.length > 0) {
                return this._verifyError(
                    400, 'INVALID_REQUEST',
                    'Request contains untrusted fields that are not accepted',
                    presentUntrusted,
                    'executed_pending_verification'
                );
            }
        }

        // ── Authenticated caller ──
        var userId = this._currentUserId();
        if (!userId || userId === 'guest') {
            return this._verifyError(
                401, 'UNAUTHORIZED',
                'Authentication required',
                ['User is not authenticated'],
                'executed_pending_verification'
            );
        }

        // ── Role check ──
        if (!this._callerHasRole(this.REQUIRED_ROLE)) {
            return this._verifyError(
                403, 'FORBIDDEN',
                'Insufficient permissions',
                ['User does not have role: ' + this.REQUIRED_ROLE],
                'executed_pending_verification'
            );
        }

        // ── Request validation ──
        if (!request || typeof request !== 'object') {
            return this._verifyError(
                400, 'INVALID_REQUEST',
                'A verification request object is required',
                ['Request must be a non-null object'],
                'executed_pending_verification'
            );
        }

        var migrationRunId = this._text(request.migration_run_id);
        var stagedCiId = this._text(request.staged_ci_id);
        var correlationId = this._text(request.correlation_id);
        var idempotencyKey = this._text(request.idempotency_key);
        var executionCorrelationId = this._text(request.execution_correlation_id);

        // Required fields
        var missing = [];
        if (!migrationRunId) missing.push('migration_run_id');
        if (!stagedCiId) missing.push('staged_ci_id');
        if (!correlationId) missing.push('correlation_id');
        if (!idempotencyKey) missing.push('idempotency_key');
        if (!executionCorrelationId) missing.push('execution_correlation_id');
        if (missing.length > 0) {
            return this._verifyError(
                400, 'INVALID_REQUEST',
                'Missing required fields',
                missing,
                'executed_pending_verification'
            );
        }

        // Valid 32-character sys_ids
        if (!this._isSysId(migrationRunId)) {
            return this._verifyError(
                400, 'INVALID_REQUEST',
                'migration_run_id must be a valid 32-character sys_id',
                ['migration_run_id: ' + migrationRunId],
                'executed_pending_verification'
            );
        }
        if (!this._isSysId(stagedCiId)) {
            return this._verifyError(
                400, 'INVALID_REQUEST',
                'staged_ci_id must be a valid 32-character sys_id',
                ['staged_ci_id: ' + stagedCiId],
                'executed_pending_verification'
            );
        }

        // Correlation and idempotency tokens
        if (!this._isValidToken(correlationId, 160)) {
            return this._verifyError(
                400, 'INVALID_REQUEST',
                'correlation_id is invalid or too long',
                ['correlation_id'],
                'executed_pending_verification'
            );
        }
        if (!this._isValidToken(idempotencyKey, 240)) {
            return this._verifyError(
                400, 'INVALID_REQUEST',
                'idempotency_key is invalid or too long',
                ['idempotency_key'],
                'executed_pending_verification'
            );
        }
        if (!this._isValidToken(executionCorrelationId, 240)) {
            return this._verifyError(
                400, 'INVALID_REQUEST',
                'execution_correlation_id is invalid or too long',
                ['execution_correlation_id'],
                'executed_pending_verification'
            );
        }

        // ── Migration run exists ──
        var runGr = this._newRecord(this.TABLES.run);
        if (!runGr.get(migrationRunId)) {
            return this._verifyError(
                404, 'NOT_FOUND',
                'Migration run not found',
                ['sys_id: ' + migrationRunId],
                'executed_pending_verification'
            );
        }

        // ── Team prefix constraint ──
        var teamPrefix = this._text(runGr.getValue('team_prefix'));
        if (teamPrefix !== this.TEAM) {
            return this._verifyError(
                403, 'FORBIDDEN',
                'Migration run does not belong to the authorized team',
                ['team_prefix: ' + teamPrefix],
                'executed_pending_verification'
            );
        }

        // ── Staged CI belongs to the exact migration run ──
        var ciGr = this._newRecord(this.TABLES.stagedCi);
        if (!ciGr.get(stagedCiId)) {
            return this._verifyError(
                404, 'NOT_FOUND',
                'Staged CI record not found',
                ['sys_id: ' + stagedCiId],
                'executed_pending_verification'
            );
        }
        if (this._text(ciGr.getValue('migration_run')) !== migrationRunId) {
            return this._verifyError(
                400, 'INVALID_REQUEST',
                'Staged CI does not belong to migration run',
                ['staged_ci migration_run: ' + ciGr.getValue('migration_run')],
                'executed_pending_verification'
            );
        }

        // Team prefix on staged CI
        var ciTeam = this._text(ciGr.getValue('team_prefix'));
        if (ciTeam && ciTeam !== this.TEAM) {
            return this._verifyError(
                403, 'FORBIDDEN',
                'Staged CI does not belong to the authorized team',
                ['team_prefix: ' + ciTeam],
                'executed_pending_verification'
            );
        }

        // ── Exact committed execution event lookup ──
        // Use CONTAINS to find candidates, then parse each and validate
        // as an execution event (not a verification event).
        var execEvent = this._newRecord(this.TABLES.ledger);
        execEvent.addQuery('migration_run', migrationRunId);
        execEvent.addQuery('event_type', 'committed');
        execEvent.addQuery('detail', 'CONTAINS', executionCorrelationId);
        execEvent.orderByDesc('sequence');
        execEvent.setLimit(20);
        execEvent.query();

        var execDetail = null;
        while (execEvent.next()) {
            var candidateDetail = this._tryParseObject(
                execEvent.getValue('detail')
            );
            if (!candidateDetail) continue;

            // Must have all four execution-shape fields
            if (!this._text(candidateDetail.target_ci_sys_id)) continue;
            if (!this._text(candidateDetail.proposed_class)) continue;
            if (!this._text(candidateDetail.execution_correlation_id)) continue;
            if (!this._text(candidateDetail.simulation_correlation_id)) continue;

            // If action is present, require ire_execution_completed
            var candidateAction = this._text(candidateDetail.action);
            if (candidateAction && candidateAction !== 'ire_execution_completed') continue;

            // Exact equality checks on parsed fields
            if (this._text(candidateDetail.execution_correlation_id) !== executionCorrelationId) continue;
            if (this._text(candidateDetail.staged_ci_id) !== stagedCiId) continue;

            // Historical compatibility: if migration_run_id is present, it must match exactly;
            // if absent, permit (the ledger record itself is already queried by migration_run)
            var parsedRunId = this._text(candidateDetail.migration_run_id);
            if (parsedRunId && parsedRunId !== migrationRunId) continue;

            execDetail = candidateDetail;
            break;
        }

        if (!execDetail) {
            return this._verifyError(
                404, 'NOT_FOUND',
                'Execution event not found',
                ['No committed event with exact execution_correlation_id: ' + executionCorrelationId],
                'executed_pending_verification'
            );
        }

        // ── Extract target from committed event ──
        var targetCiSysId = this._text(execDetail.target_ci_sys_id);
        var expectedClass = this._text(execDetail.proposed_class);

        if (!targetCiSysId) {
            return this._verifyError(
                404, 'NOT_FOUND',
                'Target CI sys_id not found in execution event',
                ['execution event detail lacks target_ci_sys_id'],
                'executed_pending_verification'
            );
        }

        // ── Valid target_ci_sys_id ──
        if (!this._isSysId(targetCiSysId)) {
            var invalidIdDetail = {
                action: 'verification_rejected',
                correlation_id: correlationId,
                idempotency_key: idempotencyKey,
                staged_ci_id: stagedCiId,
                execution_correlation_id: executionCorrelationId,
                target_ci_sys_id: targetCiSysId,
                verification_result: 'rejected',
                mismatch_categories: ['invalid_target_id'],
                summary: 'Verification rejected: execution event contains invalid target CI sys_id'
            };
            this._writeLedger(migrationRunId, 'error', invalidIdDetail);

            return this._verifyError(
                422, 'INVALID_TARGET_CI',
                'Execution event contains an invalid target CI sys_id',
                ['target_ci_sys_id: "' + targetCiSysId + '" is not a valid 32-char hex sys_id'],
                'executed_pending_verification'
            );
        }

        // ── Rebuild authoritative payload ──
        // Use buildFromPersistedStrategy when execution evidence has strategy fields;
        // otherwise use build() for the normal path.
        var payloadSvc = this._newPayloadService();
        var buildResult;
        var persistedStrategy = execDetail.strategy_evidence;
        var hasPersistedStrategy = persistedStrategy &&
            typeof persistedStrategy === 'object' &&
            this._text(persistedStrategy.source_class);

        try {
            if (hasPersistedStrategy) {
                buildResult = payloadSvc.buildFromPersistedStrategy(
                    migrationRunId, stagedCiId, persistedStrategy
                );
            } else {
                buildResult = payloadSvc.build(migrationRunId, stagedCiId);
            }
        } catch (buildErr) {
            var buildErrMsg = buildErr && buildErr.message ? buildErr.message : String(buildErr);
            return this._verifyError(
                400, 'PAYLOAD_BUILD_FAILED',
                'Failed to rebuild authoritative payload: ' + buildErrMsg,
                [buildErrMsg],
                'executed_pending_verification'
            );
        }

        var expectedName = (buildResult.authoritative_values && buildResult.authoritative_values.name) || '';

        // ── Target CI exists ──
        var cmdbGr = this._newRecord('cmdb_ci');
        if (!cmdbGr.get(targetCiSysId)) {
            var failDetail = {
                action: 'verification_failed',
                correlation_id: correlationId,
                idempotency_key: idempotencyKey,
                staged_ci_id: stagedCiId,
                execution_correlation_id: executionCorrelationId,
                target_ci_sys_id: targetCiSysId,
                expected_class: expectedClass,
                verification_result: 'fail',
                mismatch_categories: ['ci_not_found'],
                summary: 'Verification failed: CI does not exist'
            };
            this._writeLedger(migrationRunId, 'error', failDetail);

            return {
                success: true,
                state: 'verification_failed',
                migration_run_id: migrationRunId,
                staged_ci_id: stagedCiId,
                correlation_id: correlationId,
                idempotency_key: idempotencyKey,
                execution_correlation_id: executionCorrelationId,
                target_ci: { sys_id: targetCiSysId, display_value: '', table: 'cmdb_ci' },
                status: 'mismatch',
                verification_summary: 'CI with sys_id ' + targetCiSysId + ' does not exist in CMDB',
                evidence: ['Target CI not found'],
                playback_event_ids: []
            };
        }

        // ── Actual class and name compared with expected ──
        var actualClass = this._text(cmdbGr.getValue('sys_class_name'));
        var actualName = this._text(cmdbGr.getValue('name'));
        var mismatches = [];
        var mismatchCategories = [];

        if (expectedClass && actualClass !== expectedClass) {
            mismatches.push('Class mismatch: expected "' + expectedClass + '", found "' + actualClass + '"');
            mismatchCategories.push('class');
        }

        if (expectedName && actualName && actualName !== expectedName) {
            mismatches.push('Name mismatch: expected "' + expectedName + '", found "' + actualName + '"');
            mismatchCategories.push('name');
        }

        if (!actualName) {
            mismatches.push('CI name is empty — identity cannot be confirmed');
            mismatchCategories.push('identity');
        }

        var verificationSummary;
        var state;
        var eventType;
        var verifyStatus;

        if (mismatches.length > 0) {
            verificationSummary = 'Verification completed with mismatches: ' + mismatchCategories.join(', ');
            state = 'verification_failed';
            eventType = 'error';
            verifyStatus = 'mismatch';
        } else {
            verificationSummary = 'Verification successful: CI ' + targetCiSysId +
                ' exists as ' + actualClass + ' with name "' + actualName + '"';
            state = 'verified';
            eventType = 'committed';
            verifyStatus = 'verified';
        }

        // ── Compact verification ledger evidence ──
        var verifyDetail = {
            action: mismatches.length === 0 ? 'verification_passed' : 'verification_failed',
            correlation_id: correlationId,
            idempotency_key: idempotencyKey,
            staged_ci_id: stagedCiId,
            execution_correlation_id: executionCorrelationId,
            target_ci_sys_id: targetCiSysId,
            actual_class: actualClass,
            expected_class: expectedClass,
            verification_result: mismatches.length === 0 ? 'pass' : 'fail',
            mismatch_categories: mismatchCategories,
            summary: verificationSummary
        };

        var eventId = this._writeLedger(migrationRunId, eventType, verifyDetail);

        return {
            success: true,
            state: state,
            migration_run_id: migrationRunId,
            staged_ci_id: stagedCiId,
            correlation_id: correlationId,
            idempotency_key: idempotencyKey,
            execution_correlation_id: executionCorrelationId,
            target_ci: {
                sys_id: targetCiSysId,
                display_value: actualName,
                table: actualClass || 'cmdb_ci'
            },
            status: verifyStatus,
            verification_summary: verificationSummary,
            evidence: mismatches.length > 0
                ? mismatches
                : ['CI verified successfully: class=' + actualClass + ', name=' + actualName],
            playback_event_ids: [eventId]
        };
    },

    /**
     * Builds a structured error result for verifyExecution.
     * Does NOT reference REST request/response objects.
     */
    _verifyError: function(httpStatus, code, message, details, state) {
        return {
            success: false,
            http_status: httpStatus,
            code: code,
            message: message,
            details: details || [],
            state: state || 'executed_pending_verification'
        };
    },

    /**
     * Validates a token string for format and length.
     */
    _isValidToken: function(value, maximumLength) {
        if (!value) return false;
        if (value.length > maximumLength) return false;
        return /^[A-Za-z0-9:._-]+$/.test(value);
    },

    // ──────────────────────────────────────────────────────────────────
    // Phase B3A: simulate — deterministic strategy + canonical fingerprint
    // ──────────────────────────────────────────────────────────────────

    /*
     * Runs one non-mutating IRE identification simulation.
     *
     * Uses buildWithStrategy for server-authoritative payload derivation:
     * - Allowlisted classes proceed without strategy_evidence.
     * - Known aliases use normalize_known_class_alias deterministic strategy.
     * - Unknown aliases stop before identifyCI.
     * - Prior persisted retry evidence blocks another attempt.
     * - identifyCI is called at most once.
     *
     * Required request:
     * {
     *   migration_run_id: 'sys_id',
     *   staged_ci_id: 'sys_id',
     *   correlation_id: 'ks-sim-...',
     *   idempotency_key: 'simulate:run:record:...'
     * }
     */
    simulate: function(request) {
        try {
            request = this._validateRequest(request);
        } catch (requestError) {
            return this._simulateError(
                400,
                'INVALID_REQUEST',
                this.ERROR_CODE_MAP.INVALID_REQUEST.message,
                [],
                'simulation_blocked',
                '',
                ''
            );
        }

        try {
            this._validateCaller();
        } catch (callerError) {
            var callerCode = callerError && callerError.error_code
                ? String(callerError.error_code)
                : '';
            var callerMapping = this.ERROR_CODE_MAP[callerCode];

            if (!callerMapping || (callerCode !== 'UNAUTHORIZED' && callerCode !== 'FORBIDDEN')) {
                throw new Error('IRE simulation failed');
            }

            return this._simulateError(
                callerMapping.http_status,
                callerCode,
                callerMapping.message,
                [],
                'simulation_blocked',
                request.correlation_id,
                request.idempotency_key
            );
        }

        /*
         * Return the original successful result when the same
         * idempotency key is retried. Must not call buildWithStrategy,
         * identifyCI, or _writeLedger.
         */
        var previous = this._findCompletedSimulation(request);

        if (previous) {
            previous.success = true;
            previous.idempotent_replay = true;
            return previous;
        }

        try {
            /*
             * Server-authoritative payload derivation via deterministic strategy.
             * buildWithStrategy throws for unknown aliases (before identifyCI)
             * and for prior persisted retry evidence (before identifyCI).
             */
            var payloadSvc = this._newPayloadService();

            var bundle = payloadSvc.buildWithStrategy(
                request.migration_run_id,
                request.staged_ci_id
            );

            var ireInput = this._buildSupportedIreInput(bundle);

            this._logStartedOnce(request, bundle);

            /*
             * identifyCI performs identification without committing
             * the result to the CMDB. Called at most once.
             */
            var rawOutput = this._identifyCi(ireInput);

            var parsed = this._parseObject(
                rawOutput,
                'IRE identifyCI output'
            );

            var resultItem = this._validateSimulationResult(parsed);

            var operation = this._text(
                resultItem.operation
            ).toUpperCase();

            var matchedCi = this._text(resultItem.sysId);

            if (operation === 'INSERT') {
                matchedCi = '';
            }

            /*
             * Canonical fingerprint via payload service.
             * Passes bundle.strategy_evidence (null for allowlisted classes).
             */
            var simulationFingerprintValue = this._text(
                payloadSvc.fingerprintSimulation(
                    bundle,
                    operation,
                    matchedCi,
                    bundle.strategy_evidence
                )
            ).toUpperCase();

            if (!/^[0-9A-F]{64}$/.test(simulationFingerprintValue)) {
                throw new Error(
                    'The simulation fingerprint was not generated correctly. ' +
                    'Expected 64-character hexadecimal.'
                );
            }

            var findingId = this._ensureProposalFinding(
                request,
                bundle,
                operation,
                matchedCi,
                simulationFingerprintValue
            );

            /*
             * Compact ledger detail — no raw payloads, authoritative values,
             * source rows, prompts, credentials, or executable IRE input.
             * Strategy fields included only when strategy_evidence exists.
             */
            var completedDetail = {
                action: 'ire_simulation_completed',
                status: 'completed',
                migration_run_id: request.migration_run_id,
                staged_ci_id: request.staged_ci_id,
                correlation_id: request.correlation_id,
                simulation_correlation_id: request.correlation_id,
                simulation_fingerprint: simulationFingerprintValue,
                finding_id: findingId,
                operation: operation,
                simulation_matched_ci: matchedCi,
                idempotency_key: request.idempotency_key
            };

            if (bundle.strategy_evidence) {
                completedDetail.strategy_id = bundle.strategy_evidence.strategy_id;
                completedDetail.mapping_version = bundle.strategy_evidence.mapping_version;
                completedDetail.source_class = bundle.strategy_evidence.source_class;
                completedDetail.target_class = bundle.strategy_evidence.target_class;
                completedDetail.retry_count = bundle.strategy_evidence.retry_count;
                completedDetail.max_retries = bundle.strategy_evidence.max_retries;
                completedDetail.decision_source = bundle.strategy_evidence.decision_source;
                completedDetail.work_group_signature = bundle.strategy_evidence.signature || '';
            }

            this._writeLedger(
                request.migration_run_id,
                'simulated',
                completedDetail
            );

            var result = {
                success: true,
                state: 'simulated_pending_approval',
                migration_run_id: request.migration_run_id,
                staged_ci_id: request.staged_ci_id,
                correlation_id: request.correlation_id,
                simulation_correlation_id: request.correlation_id,
                idempotency_key: request.idempotency_key,
                operation: operation,
                simulation_matched_ci: matchedCi,
                proposed_class: bundle.proposed_class,
                finding_id: findingId,
                simulation_fingerprint: simulationFingerprintValue,
                idempotent_replay: false,
                cmdb_committed: false
            };

            if (bundle.strategy_evidence) {
                result.strategy_id = bundle.strategy_evidence.strategy_id;
                result.mapping_version = bundle.strategy_evidence.mapping_version;
                result.source_class = bundle.strategy_evidence.source_class;
                result.target_class = bundle.strategy_evidence.target_class;
                result.retry_count = bundle.strategy_evidence.retry_count;
                result.max_retries = bundle.strategy_evidence.max_retries;
                result.decision_source = bundle.strategy_evidence.decision_source;
                result.work_group_signature = bundle.strategy_evidence.signature || '';
            }

            return result;

        } catch (error) {
            var errorCode = error && error.error_code
                ? String(error.error_code)
                : '';
            var mapping = this.ERROR_CODE_MAP[errorCode];

            if (mapping) {
                if (this.BLOCKER_CODES[errorCode]) {
                    return this._handleBlocker(request, errorCode);
                }

                return this._simulateError(
                    mapping.http_status,
                    errorCode,
                    mapping.message,
                    [],
                    'simulation_blocked',
                    request.correlation_id,
                    request.idempotency_key
                );
            }

            gs.error('IRE simulation failed.');

            try {
                this._writeLedger(
                    request.migration_run_id,
                    'error',
                    {
                        action: 'ire_simulation_failed',
                        status: 'failed',
                        migration_run_id: request.migration_run_id,
                        staged_ci_id: request.staged_ci_id,
                        correlation_id: request.correlation_id,
                        idempotency_key: request.idempotency_key,
                        error_code: 'IRE_SIMULATION_FAILED',
                        summary: 'IRE simulation failed'
                    }
                );
            } catch (ledgerErr) {
                gs.error('Unable to record IRE simulation failure.');
            }

            throw new Error(
                'IRE simulation failed'
            );
        }
    },

    /**
     * Phase C approval entry point. The request is identifiers and correlation
     * metadata only. All executable and decision material is reread or assigned
     * on the server.
     */
    approve: function(request) {
        var normalized;

        try {
            normalized = this._validateApprovalRequest(request);
            this._validateCaller();
        } catch (validationError) {
            return this._approvalError(
                validationError && validationError.error_code === 'UNAUTHORIZED' ? 401 :
                    validationError && validationError.error_code === 'FORBIDDEN' ? 403 : 400,
                validationError && validationError.error_code ? validationError.error_code : 'INVALID_REQUEST',
                validationError && validationError.error_code === 'UNAUTHORIZED' ? 'Authentication required' :
                    validationError && validationError.error_code === 'FORBIDDEN' ? 'Insufficient permissions' :
                        'Invalid approval request',
                normalized
            );
        }

        var binding;
        try {
            binding = this._resolveApprovalBinding(normalized, true);
        } catch (bindingError) {
            return this._approvalError(
                bindingError.http_status || 409,
                bindingError.error_code || 'APPROVAL_BINDING_REJECTED',
                bindingError.public_message || 'Approval binding was rejected',
                normalized
            );
        }

        var approvalClaim;
        try {
            approvalClaim = this._insertBindingEvent(
                binding,
                'approved',
                'approval_recorded',
                binding.approval_event_id,
                {
                    decision: 'approved',
                    decided_by: binding.decided_by,
                    policy_approved: false
                }
            );
        } catch (claimError) {
            return this._approvalError(409, 'APPROVAL_CONFLICT', 'Approval binding conflicts with existing evidence', normalized);
        }

        if (approvalClaim.won) {
            try {
                this._approveReview(binding.review_record, binding.decided_by);
            } catch (reviewError) {
                return this._approvalError(503, 'APPROVAL_PERSIST_FAILED', 'Approval could not be persisted', normalized, true);
            }
        } else if (this._text(binding.review_record.getValue('decision')) !== 'approved') {
            return {
                success: true,
                http_status: 202,
                state: 'approval_recording',
                approval_event_id: binding.approval_event_id,
                idempotent_replay: true,
                handoff_queued: false
            };
        }

        return this._attemptApprovalHandoff(binding, approvalClaim.won);
    },

    /**
     * Script Action entry point. The complete binding is reread and validated
     * before the deterministic one-time resume claim is attempted.
     */
    validateAndClaimApprovalResume: function(runId, approvalEventId) {
        runId = this._text(runId).toLowerCase();
        approvalEventId = this._text(approvalEventId).toLowerCase();

        if (!this._isSysId(runId) || !this._isSysId(approvalEventId)) {
            return this._resumeResult(false, 'malformed_token', null, false);
        }

        var binding;
        try {
            binding = this._bindingFromApprovalEvent(runId, approvalEventId);
        } catch (tokenError) {
            return this._resumeResult(false, tokenError.error_code || 'stale_token', null, false);
        }

        var terminalFailure = this._findLatestBindingAction(binding, 'approval_resume_failed', 'error');
        if (terminalFailure) {
            return this._resumeResult(false, 'preparation_failed', binding, false, terminalFailure.sys_id);
        }

        var prepared = this._findLatestBindingAction(binding, 'approval_resume_prepared', 'analyzed');
        if (prepared) {
            return this._resumeResult(true, 'already_prepared', binding, false, prepared.sys_id);
        }

        var claimId = this._claimId('approval-resume', [
            binding.migration_run_id,
            binding.staged_ci_id,
            binding.approval_event_id,
            binding.simulation_fingerprint
        ]);

        var claim;
        try {
            claim = this._insertBindingEvent(
                binding,
                'analyzed',
                'approval_resume_claimed',
                claimId,
                { claim_event_id: claimId }
            );
        } catch (claimError) {
            return this._resumeResult(false, 'claim_conflict', binding, false);
        }

        if (!claim.won) {
            return this._resumeResult(true, 'already_claimed', binding, false, claimId);
        }

        return this._resumeResult(true, 'claimed', binding, true, claimId);
    },

    recordApprovalResumePrepared: function(binding, claimId) {
        if (!binding || !this._isSysId(claimId)) return false;

        var eventId = this._claimId('approval-resume-prepared', [
            binding.approval_event_id,
            claimId
        ]);

        return this._insertBindingEvent(
            binding,
            'analyzed',
            'approval_resume_prepared',
            eventId,
            { claim_event_id: claimId }
        ).won;
    },

    recordApprovalResumeFailure: function(binding, claimId) {
        if (!binding || !this._isSysId(claimId)) return false;

        var eventId = this._claimId('approval-resume-failed', [
            binding.approval_event_id,
            claimId
        ]);

        return this._insertBindingEvent(
            binding,
            'error',
            'approval_resume_failed',
            eventId,
            {
                claim_event_id: claimId,
                error_code: 'MARA_PREPARATION_FAILED'
            }
        ).won;
    },

    _validateApprovalRequest: function(request) {
        if (!request || typeof request !== 'object' ||
            Object.prototype.toString.call(request) === '[object Array]') {
            throw new Error('Approval request must be an object');
        }

        var keys = Object.keys(request);
        for (var i = 0; i < keys.length; i++) {
            if (!this.APPROVAL_FIELDS[keys[i]]) {
                throw new Error('Unknown approval request field');
            }
        }

        var fingerprint = this._text(request.simulation_fingerprint).toUpperCase();
        if (/^[0-9A-F]{32}$/.test(fingerprint)) {
            var legacyError = new Error('Legacy fingerprint rejected');
            legacyError.error_code = 'LEGACY_FINGERPRINT';
            throw legacyError;
        }
        if (!/^[0-9A-F]{64}$/.test(fingerprint)) {
            throw new Error('simulation_fingerprint must be canonical SHA-256');
        }

        return {
            migration_run_id: this._requireSysId(request.migration_run_id, 'migration_run_id').toLowerCase(),
            staged_ci_id: this._requireSysId(request.staged_ci_id, 'staged_ci_id').toLowerCase(),
            finding_id: this._requireSysId(request.finding_id, 'finding_id').toLowerCase(),
            review_decision_id: this._requireSysId(request.review_decision_id, 'review_decision_id').toLowerCase(),
            correlation_id: this._requireToken(request.correlation_id, 'correlation_id', 160),
            idempotency_key: this._requireToken(request.idempotency_key, 'idempotency_key', 240),
            simulation_correlation_id: this._requireToken(request.simulation_correlation_id, 'simulation_correlation_id', 240),
            simulation_fingerprint: fingerprint
        };
    },

    _resolveApprovalBinding: function(request, interactive) {
        var run = this._newRecord(this.TABLES.run);
        if (!run.get(request.migration_run_id)) {
            throw this._bindingError(404, 'RUN_NOT_FOUND', 'Migration run not found');
        }
        if (this._text(run.getValue('team_prefix')) !== this.TEAM) {
            throw this._bindingError(403, 'RUN_OWNERSHIP_REJECTED', 'Migration run is not authorized');
        }

        var runState = this._text(run.getValue('state'));
        if (runState !== 'awaiting_approval' && runState !== 'simulated') {
            throw this._bindingError(409, 'RUN_STATE_INVALID', 'Migration run state does not allow approval');
        }

        var staged = this._newRecord(this.TABLES.stagedCi);
        if (!staged.get(request.staged_ci_id)) {
            throw this._bindingError(404, 'STAGED_CI_NOT_FOUND', 'Staged CI record not found');
        }
        if (this._text(staged.getValue('migration_run')).toLowerCase() !== request.migration_run_id ||
            (this._text(staged.getValue('team_prefix')) && this._text(staged.getValue('team_prefix')) !== this.TEAM)) {
            throw this._bindingError(403, 'STAGED_CI_OWNERSHIP_REJECTED', 'Staged CI is not authorized for this run');
        }

        var finding = this._newRecord(this.TABLES.finding);
        if (!finding.get(request.finding_id)) {
            throw this._bindingError(404, 'FINDING_NOT_FOUND', 'Approval finding not found');
        }
        if (this._text(finding.getValue('migration_run')).toLowerCase() !== request.migration_run_id ||
            this._text(finding.getValue('staged_ci')).toLowerCase() !== request.staged_ci_id ||
            (this._text(finding.getValue('team_prefix')) && this._text(finding.getValue('team_prefix')) !== this.TEAM) ||
            this._text(finding.getValue('recommendation')).indexOf(this.PROPOSAL_PREFIX) !== 0) {
            throw this._bindingError(409, 'FINDING_MISMATCH', 'Finding does not identify the simulated proposal');
        }

        var review = this._newRecord(this.TABLES.review);
        if (!review.get(request.review_decision_id)) {
            throw this._bindingError(404, 'APPROVAL_MISSING', 'Linked approval review was not found');
        }
        if (this._text(review.getValue('migration_run')).toLowerCase() !== request.migration_run_id ||
            this._text(review.getValue('finding')).toLowerCase() !== request.finding_id ||
            (this._text(review.getValue('team_prefix')) && this._text(review.getValue('team_prefix')) !== this.TEAM)) {
            throw this._bindingError(409, 'REVIEW_MISMATCH', 'Review does not identify this finding and run');
        }

        var decision = this._text(review.getValue('decision'));
        if (decision !== 'deferred' && decision !== 'approved') {
            throw this._bindingError(409, 'REVIEW_STATE_INVALID', 'Review is not deferred for approval');
        }

        var simulation = this._latestCompletedSimulation(request);
        if (!simulation) {
            throw this._bindingError(409, 'SIMULATION_MISSING', 'Completed simulation evidence was not found');
        }
        if (this._text(simulation.finding_id).toLowerCase() !== request.finding_id) {
            throw this._bindingError(409, 'SIMULATION_FINDING_MISMATCH', 'Latest simulation is not linked to this finding');
        }
        if (this._text(simulation.simulation_correlation_id) !== request.simulation_correlation_id ||
            this._text(simulation.simulation_fingerprint).toUpperCase() !== request.simulation_fingerprint) {
            throw this._bindingError(409, 'STALE_SIMULATION', 'Approval does not reference the latest completed simulation');
        }

        var payloadService = this._newPayloadService();
        var strategy = this._strategyFromSimulation(simulation);
        var bundle = strategy ?
            payloadService.buildFromPersistedStrategy(request.migration_run_id, request.staged_ci_id, strategy) :
            payloadService.build(request.migration_run_id, request.staged_ci_id);
        var recomputed = this._text(payloadService.fingerprintSimulation(
            bundle,
            this._text(simulation.operation),
            this._text(simulation.simulation_matched_ci),
            strategy
        )).toUpperCase();

        if (!/^[0-9A-F]{64}$/.test(recomputed) || recomputed !== request.simulation_fingerprint) {
            throw this._bindingError(409, 'FINGERPRINT_MISMATCH', 'Persisted simulation fingerprint is stale or mismatched');
        }

        var decidedBy = decision === 'approved' ? this._text(review.getValue('decided_by')) : this._currentUserId();
        var binding = {
            migration_run_id: request.migration_run_id,
            staged_ci_id: request.staged_ci_id,
            finding_id: request.finding_id,
            review_decision_id: request.review_decision_id,
            correlation_id: request.correlation_id,
            idempotency_key: request.idempotency_key,
            simulation_correlation_id: request.simulation_correlation_id,
            simulation_fingerprint: recomputed,
            decision: 'approved',
            decision_source: 'deterministic',
            decided_by: decidedBy,
            policy_approved: false,
            run_record: run,
            review_record: review
        };

        binding.approval_event_id = this._claimId('approval-recorded', [
            binding.migration_run_id,
            binding.staged_ci_id,
            binding.finding_id,
            binding.review_decision_id,
            binding.simulation_correlation_id,
            binding.simulation_fingerprint
        ]);

        if (decision === 'approved') {
            var existing = this._getEvent(binding.approval_event_id);
            if (!existing || existing.event_type !== 'approved' ||
                existing.migration_run_id !== binding.migration_run_id ||
                existing.actor !== this.ACTOR || existing.team_prefix !== this.TEAM ||
                !this._detailMatchesBinding(existing.detail, binding, 'approval_recorded')) {
                throw this._bindingError(409, 'APPROVAL_REPLAY_REJECTED', 'Approved review does not match this exact approval replay');
            }
        }

        return binding;
    },

    _latestCompletedSimulation: function(request) {
        var ledger = this._newRecord(this.TABLES.ledger);
        ledger.addQuery('migration_run', request.migration_run_id);
        ledger.addQuery('event_type', 'simulated');
        ledger.addQuery('actor', this.ACTOR);
        ledger.addQuery('detail', 'CONTAINS', request.staged_ci_id);
        ledger.orderByDesc('sequence');
        ledger.orderByDesc('sys_created_on');
        ledger.setLimit(50);
        ledger.query();

        while (ledger.next()) {
            var detail = this._tryParseObject(ledger.getValue('detail'));
            if (!detail) continue;
            if (this._text(detail.action) !== 'ire_simulation_completed') continue;
            if (this._text(detail.migration_run_id).toLowerCase() !== request.migration_run_id) continue;
            if (this._text(detail.staged_ci_id).toLowerCase() !== request.staged_ci_id) continue;
            return detail;
        }

        return null;
    },

    _strategyFromSimulation: function(detail) {
        if (!this._text(detail.strategy_id)) return null;
        return {
            strategy_id: this._text(detail.strategy_id),
            mapping_version: this._text(detail.mapping_version),
            source_class: this._text(detail.source_class),
            target_class: this._text(detail.target_class),
            retry_count: this._integer(detail.retry_count),
            max_retries: this._integer(detail.max_retries),
            decision_source: 'deterministic'
        };
    },

    _approveReview: function(review, userId) {
        review.setValue('decision', 'approved');
        review.setValue('decided_by', userId);
        review.setValue('policy_approved', false);
        if (!review.update()) throw new Error('Review update failed');
    },

    _attemptApprovalHandoff: function(binding, firstAttempt) {
        var queued = this._findLatestBindingAction(binding, 'approval_handoff_queued', 'approved');
        if (queued) return this._approvalSuccess(binding, true, true);

        var attemptClaimId = binding.approval_event_id;
        if (!firstAttempt) {
            var failure = this._findLatestBindingAction(binding, 'approval_handoff_failed', 'error');
            if (!failure) {
                return {
                    success: true,
                    http_status: 202,
                    state: 'approval_handoff_pending',
                    approval_event_id: binding.approval_event_id,
                    idempotent_replay: true,
                    handoff_queued: false
                };
            }

            attemptClaimId = this._claimId('approval-handoff-retry', [
                binding.approval_event_id,
                failure.sys_id
            ]);
            var retryClaim = this._insertBindingEvent(
                binding,
                'analyzed',
                'approval_handoff_retry_claimed',
                attemptClaimId,
                { failure_event_id: failure.sys_id, claim_event_id: attemptClaimId }
            );
            if (!retryClaim.won) {
                return {
                    success: true,
                    http_status: 202,
                    state: 'approval_handoff_retry_claimed',
                    approval_event_id: binding.approval_event_id,
                    idempotent_replay: true,
                    handoff_queued: false
                };
            }
        }

        try {
            this._queueMaraEvent(binding.run_record, binding.migration_run_id, binding.approval_event_id);
        } catch (queueError) {
            var failureId = this._claimId('approval-handoff-failed', [
                binding.approval_event_id,
                attemptClaimId
            ]);
            try {
                this._insertBindingEvent(
                    binding,
                    'error',
                    'approval_handoff_failed',
                    failureId,
                    { claim_event_id: attemptClaimId, error_code: 'MARA_EVENT_QUEUE_FAILED' }
                );
            } catch (ignoredFailureWrite) {
                gs.error('Unable to record sanitized Mara handoff failure.');
            }
            return this._approvalError(503, 'MARA_HANDOFF_FAILED', 'Approval was recorded but continuation handoff must be retried', binding, true);
        }

        var queuedId = this._claimId('approval-handoff-queued', [
            binding.approval_event_id
        ]);
        try {
            this._insertBindingEvent(
                binding,
                'approved',
                'approval_handoff_queued',
                queuedId,
                { claim_event_id: attemptClaimId }
            );
        } catch (queuedMarkerError) {
            gs.error('Mara handoff queued but its compact marker could not be persisted.');
            return this._approvalError(503, 'HANDOFF_MARKER_FAILED', 'Continuation was handed off but its marker could not be persisted', binding, false);
        }

        return this._approvalSuccess(binding, false, true);
    },

    _bindingFromApprovalEvent: function(runId, approvalEventId) {
        var approval = this._getEvent(approvalEventId);
        if (!approval || approval.event_type !== 'approved' ||
            approval.migration_run_id !== runId ||
            approval.actor !== this.ACTOR ||
            approval.team_prefix !== this.TEAM ||
            this._text(approval.detail.action) !== 'approval_recorded' ||
            this._text(approval.detail.migration_run_id).toLowerCase() !== runId) {
            throw this._bindingError(409, 'TOKEN_NOT_FOUND', 'Approval resume token was not found');
        }

        var request = {
            migration_run_id: this._text(approval.detail.migration_run_id).toLowerCase(),
            staged_ci_id: this._text(approval.detail.staged_ci_id).toLowerCase(),
            finding_id: this._text(approval.detail.finding_id).toLowerCase(),
            review_decision_id: this._text(approval.detail.review_decision_id).toLowerCase(),
            correlation_id: this._text(approval.detail.correlation_id),
            idempotency_key: this._text(approval.detail.idempotency_key),
            simulation_correlation_id: this._text(approval.detail.simulation_correlation_id),
            simulation_fingerprint: this._text(approval.detail.simulation_fingerprint).toUpperCase()
        };
        request = this._validateApprovalRequest(request);

        var binding = this._resolveApprovalBinding(request, false);
        if (binding.approval_event_id !== approvalEventId ||
            !this._detailMatchesBinding(approval.detail, binding, 'approval_recorded') ||
            this._text(approval.detail.decision) !== 'approved' ||
            this._text(approval.detail.decision_source) !== 'deterministic' ||
            approval.detail.policy_approved !== false) {
            throw this._bindingError(409, 'TOKEN_MISMATCH', 'Approval resume token no longer matches persisted evidence');
        }

        if (!this._findLatestBindingAction(binding, 'approval_handoff_queued', 'approved')) {
            throw this._bindingError(409, 'TOKEN_NOT_QUEUED', 'Approval resume token has no completed handoff');
        }

        return binding;
    },

    _insertBindingEvent: function(binding, eventType, action, eventId, extra) {
        var detail = this._bindingDetail(binding, action, extra);
        var ledger = this._newRecord(this.TABLES.ledger);
        var inserted = '';

        try {
            ledger.initialize();
            ledger.setNewGuidValue(eventId);
            ledger.setValue('migration_run', binding.migration_run_id);
            if (ledger.isValidField('team_prefix')) ledger.setValue('team_prefix', this.TEAM);
            ledger.setValue('actor', this.ACTOR);
            ledger.setValue('event_type', eventType);
            ledger.setValue('sequence', this._nextSequence(binding.migration_run_id));
            ledger.setValue('detail', new DotwalkersAgentEventDetailService().build(detail));
            inserted = this._text(ledger.insert()).toLowerCase();
        } catch (ignoredDuplicate) {
            inserted = '';
        }

        if (inserted === eventId) {
            return { won: true, sys_id: eventId, detail: detail };
        }

        var existing = this._getEvent(eventId);
        if (existing && existing.event_type === eventType &&
            existing.migration_run_id === binding.migration_run_id &&
            existing.actor === this.ACTOR &&
            existing.team_prefix === this.TEAM &&
            this._detailMatchesBinding(existing.detail, binding, action)) {
            return { won: false, sys_id: eventId, detail: existing.detail };
        }

        throw new Error('Deterministic ledger claim failed');
    },

    _bindingDetail: function(binding, action, extra) {
        var detail = {
            phase: 'remediate',
            actor: this.ACTOR,
            action: action,
            status: action.indexOf('failed') >= 0 ? 'failed' : 'completed',
            summary: this._approvalSummary(action),
            decision_source: 'deterministic',
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
            policy_approved: false
        };
        extra = extra || {};
        var allowedExtra = ['claim_event_id', 'failure_event_id', 'error_code', 'decided_by'];
        for (var i = 0; i < allowedExtra.length; i++) {
            if (extra.hasOwnProperty(allowedExtra[i])) detail[allowedExtra[i]] = extra[allowedExtra[i]];
        }
        return detail;
    },

    _detailMatchesBinding: function(detail, binding, action) {
        if (!detail || typeof detail !== 'object') return false;
        return this._text(detail.action) === action &&
            this._text(detail.decision) === 'approved' &&
            this._text(detail.decision_source) === 'deterministic' &&
            detail.policy_approved === false &&
            this._text(detail.migration_run_id).toLowerCase() === binding.migration_run_id &&
            this._text(detail.staged_ci_id).toLowerCase() === binding.staged_ci_id &&
            this._text(detail.finding_id).toLowerCase() === binding.finding_id &&
            this._text(detail.review_decision_id).toLowerCase() === binding.review_decision_id &&
            this._text(detail.correlation_id) === binding.correlation_id &&
            this._text(detail.idempotency_key) === binding.idempotency_key &&
            this._text(detail.simulation_correlation_id) === binding.simulation_correlation_id &&
            this._text(detail.simulation_fingerprint).toUpperCase() === binding.simulation_fingerprint &&
            this._text(detail.approval_event_id).toLowerCase() === binding.approval_event_id;
    },

    _findLatestBindingAction: function(binding, action, eventType) {
        var ledger = this._newRecord(this.TABLES.ledger);
        ledger.addQuery('migration_run', binding.migration_run_id);
        ledger.addQuery('event_type', eventType);
        ledger.addQuery('actor', this.ACTOR);
        ledger.addQuery('team_prefix', this.TEAM);
        ledger.addQuery('detail', 'CONTAINS', binding.approval_event_id);
        ledger.addQuery('detail', 'CONTAINS', action);
        ledger.orderByDesc('sequence');
        ledger.setLimit(50);
        ledger.query();

        while (ledger.next()) {
            var detail = this._tryParseObject(ledger.getValue('detail'));
            if (this._detailMatchesBinding(detail, binding, action)) {
                return { sys_id: this._text(ledger.getUniqueValue()).toLowerCase(), detail: detail };
            }
        }
        return null;
    },

    _getEvent: function(eventId) {
        var ledger = this._newRecord(this.TABLES.ledger);
        if (!ledger.get(eventId)) return null;
        var detail = this._tryParseObject(ledger.getValue('detail'));
        if (!detail) return null;
        return {
            sys_id: this._text(ledger.getUniqueValue()).toLowerCase(),
            event_type: this._text(ledger.getValue('event_type')),
            migration_run_id: this._text(ledger.getValue('migration_run')).toLowerCase(),
            actor: this._text(ledger.getValue('actor')),
            team_prefix: this._text(ledger.getValue('team_prefix')),
            detail: detail
        };
    },

    _claimId: function(namespace, parts) {
        return this._sha256(JSON.stringify({
            namespace: namespace,
            parts: parts
        })).substring(0, 32);
    },

    _bindingError: function(httpStatus, code, message) {
        var error = new Error(code);
        error.http_status = httpStatus;
        error.error_code = code;
        error.public_message = message;
        return error;
    },

    _approvalSummary: function(action) {
        var summaries = {
            approval_recorded: 'Exact simulation approval recorded',
            approval_handoff_queued: 'Mara approval continuation queued',
            approval_handoff_retry_claimed: 'Mara handoff retry claimed',
            approval_handoff_failed: 'Mara handoff failed safely',
            approval_resume_claimed: 'Approval resume token claimed',
            approval_resume_prepared: 'Approval continuation prepared',
            approval_resume_failed: 'Approval continuation preparation failed safely'
        };
        return summaries[action] || 'Approval lifecycle updated';
    },

    _approvalSuccess: function(binding, replay, queued) {
        return {
            success: true,
            http_status: 200,
            state: 'approved_handoff_queued',
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
            idempotent_replay: replay === true,
            handoff_queued: queued === true,
            cmdb_committed: false
        };
    },

    _approvalError: function(status, code, message, request, retryable) {
        request = request || {};
        return {
            success: false,
            http_status: status,
            state: 'simulated_pending_approval',
            code: code,
            message: message,
            retryable: retryable === true,
            correlation_id: this._text(request.correlation_id),
            idempotency_key: this._text(request.idempotency_key),
            cmdb_committed: false
        };
    },

    _resumeResult: function(success, state, binding, claimed, eventId) {
        return {
            success: success,
            state: state,
            claimed: claimed === true,
            claim_event_id: eventId || '',
            binding: binding ? this._resumeBinding(binding) : null,
            cmdb_committed: false
        };
    },

    _resumeBinding: function(binding) {
        return {
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
            decided_by: binding.decided_by,
            policy_approved: false
        };
    },

    _simulateError: function(
        httpStatus, code, message, details, state,
        correlationId, idempotencyKey
    ) {
        return {
            success: false,
            http_status: httpStatus,
            code: code,
            message: message,
            details: details || [],
            state: state || 'not_simulated',
            correlation_id: correlationId || '',
            idempotency_key: idempotencyKey || ''
        };
    },

    _handleBlocker: function(request, errorCode) {
        var mapping = this.ERROR_CODE_MAP[errorCode];
        var summary = this.BLOCKER_SUMMARY_MAP[errorCode];

        if (!this._blockerEventExists(request, errorCode)) {
            try {
                this._writeLedger(
                    request.migration_run_id,
                    'error',
                    {
                        action: 'ire_simulation_blocked',
                        status: 'blocked',
                        migration_run_id: request.migration_run_id,
                        staged_ci_id: request.staged_ci_id,
                        correlation_id: request.correlation_id,
                        idempotency_key: request.idempotency_key,
                        error_code: errorCode,
                        summary: summary,
                        decision_source: 'deterministic'
                    }
                );
            } catch (ignoredLedgerError) {
                gs.error('Unable to record IRE simulation blocker.');
            }
        }

        return this._simulateError(
            mapping.http_status,
            errorCode,
            summary,
            [],
            'simulation_blocked',
            request.correlation_id,
            request.idempotency_key
        );
    },

    _blockerEventExists: function(request, errorCode) {
        var ledger = this._newRecord(this.TABLES.ledger);

        ledger.addQuery('migration_run', request.migration_run_id);
        ledger.addQuery('event_type', 'error');
        ledger.addQuery('actor', this.ACTOR);
        ledger.addQuery(
            'detail', 'CONTAINS',
            '"action":"ire_simulation_blocked"'
        );
        ledger.addQuery(
            'detail', 'CONTAINS',
            '"idempotency_key":"' + request.idempotency_key + '"'
        );
        ledger.setLimit(10);
        ledger.query();

        while (ledger.next()) {
            var detail = this._tryParseObject(ledger.getValue('detail'));

            if (
                detail &&
                detail.action === 'ire_simulation_blocked' &&
                detail.migration_run_id === request.migration_run_id &&
                detail.staged_ci_id === request.staged_ci_id &&
                detail.idempotency_key === request.idempotency_key &&
                detail.error_code === errorCode
            ) {
                return true;
            }
        }

        return false;
    },

    _validateCaller: function() {
        var userId = this._currentUserId();
        if (!userId || userId === 'guest') {
            var unauthorized = new Error('An authenticated ServiceNow user is required.');
            unauthorized.error_code = 'UNAUTHORIZED';
            throw unauthorized;
        }

        if (!this._callerHasRole(this.REQUIRED_ROLE)) {
            var forbidden = new Error('The caller is not authorized to run IRE simulation.');
            forbidden.error_code = 'FORBIDDEN';
            throw forbidden;
        }
    },

    _validateRequest: function(request) {
        if (!request || typeof request !== 'object') {
            throw new Error(
                'A simulation request object is required.'
            );
        }

        var allowedFields = {
            migration_run_id: true,
            staged_ci_id: true,
            correlation_id: true,
            idempotency_key: true
        };

        var keys = Object.keys(request);
        for (var i = 0; i < keys.length; i++) {
            if (!allowedFields[keys[i]]) {
                throw new Error('INVALID_REQUEST');
            }
        }

        var normalized = {
            migration_run_id: this._requireSysId(
                request.migration_run_id,
                'migration_run_id'
            ),
            staged_ci_id: this._requireSysId(
                request.staged_ci_id,
                'staged_ci_id'
            ),
            correlation_id: this._requireToken(
                request.correlation_id,
                'correlation_id',
                160
            ),
            idempotency_key: this._requireToken(
                request.idempotency_key,
                'idempotency_key',
                240
            )
        };

        return normalized;
    },

    /*
     * Pass only documented IRE item properties.
     * internal_id stays application-side and is not sent to IRE.
     */
    _buildSupportedIreInput: function(bundle) {
        if (
            !bundle ||
            !bundle.ire_payload ||
            !bundle.ire_payload.items ||
            !bundle.ire_payload.items.length
        ) {
            throw new Error(
                'The authoritative IRE payload is missing.'
            );
        }

        var sourceItem = bundle.ire_payload.items[0];

        var input = {
            items: [
                {
                    className: this._text(sourceItem.className),
                    values: sourceItem.values || {}
                }
            ]
        };

        return JSON.stringify(input);
    },

    _validateSimulationResult: function(parsed) {
        if (
            !parsed ||
            !parsed.items ||
            Object.prototype.toString.call(parsed.items) !== '[object Array]' ||
            parsed.items.length !== 1
        ) {
            throw new Error(
                'IRE simulation did not return exactly one result item.'
            );
        }

        var item = parsed.items[0] || {};

        var operation = this._text(item.operation).toUpperCase();

        var allowed = {
            DELETE: true,
            INSERT: true,
            NO_CHANGE: true,
            UPDATE: true,
            UPDATE_WITH_DOWNGRADE: true,
            UPDATE_WITH_SWITCH: true,
            UPDATE_WITH_UPGRADE: true
        };

        if (!allowed[operation]) {
            throw new Error(
                'IRE returned an unsupported or empty operation: ' + operation
            );
        }

        var errorCount = this._integer(item.errorCount);

        if (parsed.hasError === true || errorCount > 0) {
            throw new Error(
                'IRE returned errors: ' + this._summarizeErrors(item)
            );
        }

        var sysId = this._text(item.sysId);

        if (operation !== 'INSERT' && sysId && !this._isSysId(sysId)) {
            throw new Error(
                'IRE returned an invalid matched CI sys_id.'
            );
        }

        return item;
    },

    _summarizeErrors: function(item) {
        var errors = item && item.errors ? item.errors : [];

        try {
            return this._limit(JSON.stringify(errors), 500);
        } catch (ignored) {
            return 'Unknown IRE error.';
        }
    },

    _ensureProposalFinding: function(
        request, bundle, operation, matchedCi, simulationFingerprint
    ) {
        var finding = new GlideRecord(this.TABLES.finding);

        finding.addQuery('migration_run', request.migration_run_id);
        finding.addQuery('staged_ci', request.staged_ci_id);

        if (finding.isValidField('team_prefix')) {
            finding.addQuery('team_prefix', this.TEAM);
        }

        finding.addQuery('type', 'data_quality');
        finding.addQuery('recommendation', 'STARTSWITH', this.PROPOSAL_PREFIX);
        finding.setLimit(1);
        finding.query();

        var recommendation =
            this.PROPOSAL_PREFIX +
            'Simulation predicts ' + operation +
            ' for ' + bundle.staged_ci_number +
            ' (' + bundle.proposed_class + '). ' +
            'Human approval is required before execution. ' +
            'Simulation fingerprint: ' + simulationFingerprint +
            (matchedCi ? '. Candidate CI: ' + matchedCi : '');

        recommendation = this._limit(recommendation, 1000);

        if (finding.next()) {
            finding.setValue('recommendation', recommendation);

            if (finding.isValidField('severity')) {
                finding.setValue(
                    'severity',
                    operation === 'INSERT' ? 'info' : 'warning'
                );
            }

            finding.update();
            return String(finding.getUniqueValue());
        }

        finding.initialize();
        finding.setValue('migration_run', request.migration_run_id);
        finding.setValue('staged_ci', request.staged_ci_id);

        if (finding.isValidField('team_prefix')) {
            finding.setValue('team_prefix', this.TEAM);
        }

        finding.setValue('type', 'data_quality');

        if (finding.isValidField('severity')) {
            finding.setValue(
                'severity',
                operation === 'INSERT' ? 'info' : 'warning'
            );
        }

        finding.setValue('recommendation', recommendation);

        var findingId = finding.insert();

        if (!findingId) {
            throw new Error(
                'Unable to create the IRE remediation proposal finding.'
            );
        }

        return String(findingId);
    },

    _findCompletedSimulation: function(request) {
        var ledger = new GlideRecord(this.TABLES.ledger);

        ledger.addQuery('migration_run', request.migration_run_id);
        ledger.addQuery('event_type', 'simulated');
        ledger.addQuery('actor', this.ACTOR);
        ledger.addQuery(
            'detail', 'CONTAINS',
            '"idempotency_key":"' + request.idempotency_key + '"'
        );

        ledger.orderByDesc('sequence');
        ledger.setLimit(10);
        ledger.query();

        while (ledger.next()) {
            var detail = this._tryParseObject(
                ledger.getValue('detail')
            );

            if (
                detail &&
                detail.action === 'ire_simulation_completed' &&
                detail.staged_ci_id === request.staged_ci_id &&
                detail.idempotency_key === request.idempotency_key
            ) {
                var replay = {
                    state: 'simulated_pending_approval',
                    migration_run_id: request.migration_run_id,
                    staged_ci_id: request.staged_ci_id,
                    correlation_id: detail.correlation_id,
                    simulation_correlation_id: detail.simulation_correlation_id || detail.correlation_id,
                    idempotency_key: detail.idempotency_key,
                    operation: detail.operation,
                    simulation_matched_ci: detail.simulation_matched_ci || '',
                    simulation_fingerprint: detail.simulation_fingerprint,
                    cmdb_committed: false
                };

                // Include strategy fields only when they exist in the persisted detail
                if (detail.strategy_id) {
                    replay.strategy_id = detail.strategy_id;
                    replay.mapping_version = detail.mapping_version || '';
                    replay.source_class = detail.source_class || '';
                    replay.target_class = detail.target_class || '';
                    replay.retry_count = detail.retry_count;
                    replay.max_retries = detail.max_retries;
                    replay.decision_source = detail.decision_source || '';
                    replay.work_group_signature = detail.work_group_signature || '';
                }

                return replay;
            }
        }

        return null;
    },

    _logStartedOnce: function(request, bundle) {
        if (this._actionExists(request, 'ire_simulation_started')) {
            return;
        }

        this._writeLedger(
            request.migration_run_id,
            'simulated',
            {
                action: 'ire_simulation_started',
                staged_ci_id: request.staged_ci_id,
                correlation_id: request.correlation_id,
                idempotency_key: request.idempotency_key,
                input_fingerprint: bundle.input_fingerprint,
                proposed_class: bundle.proposed_class
            }
        );
    },

    _actionExists: function(request, actionName) {
        var ledger = new GlideRecord(this.TABLES.ledger);

        ledger.addQuery('migration_run', request.migration_run_id);
        ledger.addQuery('actor', this.ACTOR);
        ledger.addQuery(
            'detail', 'CONTAINS',
            '"idempotency_key":"' + request.idempotency_key + '"'
        );
        ledger.addQuery(
            'detail', 'CONTAINS',
            '"action":"' + actionName + '"'
        );

        ledger.setLimit(1);
        ledger.query();

        return ledger.hasNext();
    },

    _writeLedger: function(runId, eventType, detail) {
        var ledger = new GlideRecord(this.TABLES.ledger);

        ledger.initialize();
        ledger.setValue('migration_run', runId);

        if (ledger.isValidField('team_prefix')) {
            ledger.setValue('team_prefix', this.TEAM);
        }

        ledger.setValue('actor', this.ACTOR);
        ledger.setValue('event_type', eventType);
        ledger.setValue('sequence', this._nextSequence(runId));
        ledger.setValue(
            'detail',
            this._limit(JSON.stringify(detail || {}), 3500)
        );

        var ledgerId = ledger.insert();

        if (!ledgerId) {
            throw new Error(
                'Unable to write the Remediate Event Ledger record.'
            );
        }

        return String(ledgerId);
    },

    _nextSequence: function(runId) {
        runId = this._text(runId);

        if (this._sequenceCache.hasOwnProperty(runId)) {
            this._sequenceCache[runId]++;
            return this._sequenceCache[runId];
        }

        // Read the highest persisted sequence as a record value. In the
        // scoped application, GlideAggregate MAX(sequence) can return an
        // empty value for this field and restart the run at sequence 1.
        // Ordering the ledger itself preserves the existing display sequence
        // while Phase C's deterministic sys_ids remain the atomic claims.
        var latest = this._newRecord(this.TABLES.ledger);

        latest.addQuery('migration_run', runId);
        latest.orderByDesc('sequence');
        latest.orderByDesc('sys_created_on');
        latest.setLimit(1);
        latest.query();

        var maximum = 0;

        if (latest.next()) {
            maximum = this._integer(latest.getValue('sequence'));
        }

        this._sequenceCache[runId] = maximum + 1;
        return this._sequenceCache[runId];
    },

    _parseObject: function(value, label) {
        try {
            var parsed = JSON.parse(String(value || ''));

            if (
                !parsed ||
                typeof parsed !== 'object' ||
                Object.prototype.toString.call(parsed) === '[object Array]'
            ) {
                throw new Error(label + ' must be a JSON object.');
            }

            return parsed;
        } catch (error) {
            throw new Error(
                'Unable to parse ' + label + ': ' +
                (error && error.message ? error.message : String(error))
            );
        }
    },

    _tryParseObject: function(value) {
        try {
            var parsed = JSON.parse(String(value || ''));
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (ignored) {
            return null;
        }
    },

    _requireSysId: function(value, label) {
        value = this._text(value);

        if (!this._isSysId(value)) {
            throw new Error(
                label + ' must be a valid 32-character sys_id.'
            );
        }

        return value;
    },

    _requireToken: function(value, label, maximumLength) {
        value = this._text(value);

        if (!value) {
            throw new Error(label + ' is required.');
        }

        if (value.length > maximumLength) {
            throw new Error(label + ' is too long.');
        }

        if (!/^[A-Za-z0-9:._-]+$/.test(value)) {
            throw new Error(label + ' contains unsupported characters.');
        }

        return value;
    },

    _isSysId: function(value) {
        return /^[0-9a-f]{32}$/i.test(String(value || ''));
    },

    _integer: function(value) {
        var parsed = parseInt(value, 10);
        return isNaN(parsed) ? 0 : parsed;
    },

    _limit: function(value, maximumLength) {
        value = String(value || '');
        return value.length > maximumLength
            ? value.substring(0, maximumLength)
            : value;
    },

    _text: function(value) {
        if (
            value === undefined ||
            value === null ||
            String(value) === 'null'
        ) {
            return '';
        }

        return String(value).trim();
    },

    type: 'DotwalkersIreSimulationService'
};

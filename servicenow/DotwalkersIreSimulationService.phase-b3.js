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

            ledger:
                'x_kest_dotwalkers_event_ledger'
        };

        this.ACTOR = 'Remediate';

        this.PROPOSAL_PREFIX =
            '[IRE remediation proposal] ';

        this.REQUIRED_ROLE =
            'x_kest_dotwalkers.migration_run_user';

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

        var aggregate = new GlideAggregate(this.TABLES.ledger);

        aggregate.addQuery('migration_run', runId);
        aggregate.addAggregate('MAX', 'sequence');
        aggregate.query();

        var maximum = 0;

        if (aggregate.next()) {
            maximum = this._integer(
                aggregate.getAggregate('MAX', 'sequence')
            );
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

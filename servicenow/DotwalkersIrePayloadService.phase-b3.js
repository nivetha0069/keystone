var DotwalkersIrePayloadService = Class.create();

DotwalkersIrePayloadService.prototype = {
    initialize: function() {
        this.TEAM = 'THE_DOTWALKERS';
        this.RUN_TABLE = 'x_kest_dotwalkers_migration_run';
        this.CI_TABLE = 'x_kest_dotwalkers_staged_ci_record';
        this.LEDGER_TABLE = 'x_kest_dotwalkers_event_ledger';
        this.MIN_CONFIDENCE = parseInt(
            gs.getProperty(
                'x_kest_dotwalkers.ire.minimum_confidence',
                '50'
            ),
            10
        );

        if (isNaN(this.MIN_CONFIDENCE)) {
            this.MIN_CONFIDENCE = 50;
        }

        this.ALLOWED_CLASSES = this._csvSet(
            gs.getProperty(
                'x_kest_dotwalkers.ire.allowed_classes',
                'cmdb_ci_server,cmdb_ci_linux_server,cmdb_ci_win_server'
            )
        );

        this.SCALAR_FIELDS = [
            'name',
            'host_name',
            'fqdn',
            'ip_address',
            'mac_address',
            'serial_number',
            'asset_tag',
            'short_description',
            'environment',
            'os',
            'os_version'
        ];
    },

    /**
     * Public entry: loads/validates records and calls the private authoritative
     * method using the persisted proposed class and no strategy.
     */
    build: function(runId, stagedCiId) {
        runId = this._requireSysId(runId, 'migration_run_id');
        stagedCiId = this._requireSysId(stagedCiId, 'staged_ci_id');

        var run = this._loadRun(runId);
        var staged = this._loadStagedCi(runId, stagedCiId);

        this._validateRun(run);
        this._validateCandidate(staged);

        var proposedClass = this._text(staged.getValue('proposed_class'));
        this._validateClass(proposedClass);

        return this._buildAuthoritativeBundle(run, staged, proposedClass, null);
    },

    /**
     * Public entry: loads records once; if persisted class is allowlisted,
     * calls the private method without strategy. If not allowlisted, derives
     * prior retry evidence from exact parsed Event Ledger detail, calls
     * decide(), validates with reconstruct(), and calls the private method
     * with the reconstructed target class.
     * Does not modify the staged CI record.
     */
    buildWithStrategy: function(runId, stagedCiId) {
        runId = this._requireSysId(runId, 'migration_run_id');
        stagedCiId = this._requireSysId(stagedCiId, 'staged_ci_id');

        var run = this._loadRun(runId);
        var staged = this._loadStagedCi(runId, stagedCiId);

        this._validateRun(run);
        this._validateCandidate(staged);

        var proposedClass = this._text(staged.getValue('proposed_class'));

        // If the persisted class is already allowlisted, use normal path
        if (this.ALLOWED_CLASSES[proposedClass]) {
            return this._buildAuthoritativeBundle(run, staged, proposedClass, null);
        }

        // Not allowlisted — derive prior retry evidence from Event Ledger
        var retryCount = this._countPriorRetries(runId, stagedCiId);

        var strategySvc = new DotwalkersFailureStrategyService();
        var decision = strategySvc.decide({ source_class: proposedClass }, retryCount);

        if (decision.status !== 'selected') {
            var strategyError = new Error(
                'Strategy blocked: ' + (decision.blocker || 'No allowlisted deterministic strategy')
            );
            strategyError.error_code = retryCount > 0
                ? 'RETRY_LIMIT_REACHED'
                : 'UNSUPPORTED_CLASS_ALIAS';
            throw strategyError;
        }

        // Validate with reconstruct()
        var reconstructed = strategySvc.reconstruct(decision);
        var effectiveClass = reconstructed.target_class;

        // Validate the effective class
        this._validateClass(effectiveClass);

        return this._buildAuthoritativeBundle(run, staged, effectiveClass, reconstructed);
    },

    /**
     * Server-only entry: loads run and staged CI, reconstructs and validates
     * strategyEvidence, requires evidence.source_class to equal the persisted
     * proposed_class, and builds through _buildAuthoritativeBundle using the
     * reconstructed target class. Performs no retry selection and no record write.
     */
    buildFromPersistedStrategy: function(runId, stagedCiId, strategyEvidence) {
        runId = this._requireSysId(runId, 'migration_run_id');
        stagedCiId = this._requireSysId(stagedCiId, 'staged_ci_id');

        var run = this._loadRun(runId);
        var staged = this._loadStagedCi(runId, stagedCiId);

        this._validateRun(run);
        this._validateCandidate(staged);

        if (!strategyEvidence || typeof strategyEvidence !== 'object') {
            throw new Error('Structured strategy evidence is required for buildFromPersistedStrategy');
        }

        var proposedClass = this._text(staged.getValue('proposed_class'));
        var sourceClass = this._text(strategyEvidence.source_class);

        if (sourceClass !== proposedClass) {
            throw new Error(
                'Strategy source_class (' + sourceClass +
                ') does not match persisted proposed_class (' + proposedClass + ')'
            );
        }

        var reconstructed = this._validateStrategyEvidence(strategyEvidence);
        var effectiveClass = reconstructed.target_class;

        this._validateClass(effectiveClass);

        return this._buildAuthoritativeBundle(run, staged, effectiveClass, reconstructed);
    },

    /**
     * Private authoritative method: constructs the full payload bundle.
     * All payload, reference-resolution, confidence, and fingerprint logic
     * lives here exclusively — no duplication.
     */
    _buildAuthoritativeBundle: function(run, staged, effectiveClass, strategyEvidence) {
        var runId = String(run.getUniqueValue());
        var stagedCiId = String(staged.getUniqueValue());

        var payload = this._parseObject(
            staged.getValue('payload')
        );

        var target = new GlideRecord(effectiveClass);
        var values = {};
        var omittedReferences = [];

        for (var index = 0; index < this.SCALAR_FIELDS.length; index++) {
            var field = this.SCALAR_FIELDS[index];

            if (!target.isValidField(field)) {
                continue;
            }

            var value = this._text(payload[field]);

            if (value) {
                values[field] = value;
            }
        }

        if (!values.name) {
            values.name = this._text(
                payload.name ||
                payload.host_name ||
                staged.getValue('source_identifier')
            );
        }

        if (!values.name) {
            throw new Error('No usable CI name exists.');
        }

        this._resolveReference(
            target, values, omittedReferences,
            'support_group', 'sys_user_group', 'name',
            payload.support_group
        );

        this._resolveReference(
            target, values, omittedReferences,
            'owned_by', 'sys_user', 'name',
            payload.owner || payload.owned_by
        );

        var sourceKey = this._text(
            payload.source_key ||
            staged.getValue('source_identifier')
        );

        var irePayload = {
            items: [
                {
                    className: effectiveClass,
                    internal_id: stagedCiId,
                    values: values
                }
            ]
        };

        var fingerprintInput = {
            version: 'dotwalkers-ire-input-v1',
            migration_run_id: runId,
            staged_ci_id: stagedCiId,
            staged_updated_on: this._text(staged.getValue('sys_updated_on')),
            staged_mod_count: this._text(staged.getValue('sys_mod_count')),
            proposed_class: effectiveClass,
            source_identifier: this._text(staged.getValue('source_identifier')),
            source_key: sourceKey,
            values: values
        };

        var validatedStrategyEvidence = null;

        // Reconstruct strategy evidence before it can affect payload identity.
        if (strategyEvidence) {
            validatedStrategyEvidence = this._validateStrategyEvidence(strategyEvidence);
            var strategySvc = new DotwalkersFailureStrategyService();
            fingerprintInput.strategy_material = strategySvc.fingerprintMaterial(validatedStrategyEvidence);
            fingerprintInput.strategy_retry_count = validatedStrategyEvidence.retry_count;
            fingerprintInput.strategy_max_retries = validatedStrategyEvidence.max_retries;
        }

        var confidence = this._integer(staged.getValue('confidence'));

        return {
            success: true,
            migration_run_id: runId,
            migration_run_number: this._text(run.getValue('number')),
            run_state: this._text(run.getValue('state')),
            staged_ci_id: stagedCiId,
            staged_ci_number: this._text(staged.getValue('number')),
            confidence: confidence,
            identification_status: this._text(staged.getValue('identification_status')),
            proposed_class: effectiveClass,
            source_identifier: this._text(staged.getValue('source_identifier')),
            source_key: sourceKey,
            strategy_evidence: validatedStrategyEvidence,
            authoritative_values: values,
            omitted_references: omittedReferences,
            ire_payload: irePayload,
            ire_input: JSON.stringify(irePayload),
            input_fingerprint: this._sha256(JSON.stringify(fingerprintInput))
        };
    },

    /**
     * Fingerprints a simulation result. When strategyEvidence (4th arg) is present:
     * - Calls reconstruct() internally to validate
     * - Requires reconstructed retry_count=1 and max_retries=1
     * - Generates strategy material internally
     * - Fingerprints only reconstructed server-owned strategy fields
     * - Rejects stale strategy ID, mapping version, source/target mapping, retry count, or max retries
     */
    fingerprintSimulation: function(bundle, operation, matchedCi, strategyEvidence) {
        if (!bundle || bundle.success !== true || !bundle.input_fingerprint) {
            throw new Error('Valid payload bundle required.');
        }

        operation = this._text(operation).toUpperCase();

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
            throw new Error('Unsupported IRE operation: ' + operation);
        }

        matchedCi = this._text(matchedCi);

        if (matchedCi && !this._isSysId(matchedCi)) {
            throw new Error('Invalid matched CI sys_id.');
        }

        var input = {
            version: 'dotwalkers-ire-simulation-v1',
            input_fingerprint: bundle.input_fingerprint,
            operation: operation,
            simulation_matched_ci: matchedCi
        };

        var bundleStrategy = bundle.strategy_evidence || null;

        if ((bundleStrategy && !strategyEvidence) || (!bundleStrategy && strategyEvidence)) {
            throw new Error('Simulation strategy evidence does not match the authoritative payload bundle');
        }

        // Strategy evidence must be valid and bound to this exact bundle.
        if (bundleStrategy) {
            var strategySvc = new DotwalkersFailureStrategyService();

            // Validate with reconstruct() — throws on stale strategy_id,
            // mapping_version, or inconsistent source/target mapping
            var reconstructed = this._validateStrategyEvidence(bundleStrategy);
            var reconstructedArgument = this._validateStrategyEvidence(strategyEvidence);

            if (this._strategyEvidenceKey(reconstructed) !==
                this._strategyEvidenceKey(reconstructedArgument)) {
                throw new Error('Simulation strategy evidence does not match the authoritative payload bundle');
            }

            // Generate strategy material internally and fingerprint
            // only the reconstructed server-owned strategy fields
            input.strategy_material = strategySvc.fingerprintMaterial(reconstructed);
            input.strategy_retry_count = reconstructed.retry_count;
            input.strategy_max_retries = reconstructed.max_retries;
        }

        return this._sha256(JSON.stringify(input));
    },

    /**
     * Returns true if the value is exactly 32 hexadecimal characters (legacy MD5-style).
     */
    isLegacyFingerprint: function(value) {
        return /^[0-9a-f]{32}$/i.test(String(value || ''));
    },

    /**
     * Returns true if the value is exactly 64 hexadecimal characters (canonical SHA-256).
     */
    isCanonicalFingerprint: function(value) {
        return /^[0-9a-f]{64}$/i.test(String(value || ''));
    },

    /**
     * Counts prior successful retry evidence for the exact run and staged CI.
     * Only a successfully selected/completed retry counts.
     * Blocked, failed, unrelated, malformed, and idempotent replay events do not count.
     */
    _countPriorRetries: function(runId, stagedCiId) {
        var ledger = new GlideRecord(this.LEDGER_TABLE);
        ledger.addQuery('migration_run', runId);
        ledger.addQuery('team_prefix', this.TEAM);
        ledger.query();

        while (ledger.next()) {
            var detail = String(ledger.getValue('detail') || '');

            // Attempt to parse as JSON
            var parsed = null;
            try {
                parsed = JSON.parse(detail);
            } catch (e) {
                // Not JSON — malformed, skip
                continue;
            }

            if (this._isCountedRetryEvidence(parsed, runId, stagedCiId)) {
                // Any prior authorized retry exhausts the one-retry policy.
                return 1;
            }
        }

        return 0;
    },

    _isCountedRetryEvidence: function(parsed, runId, stagedCiId) {
        if (!parsed || typeof parsed !== 'object') {
            return false;
        }

        if (this._text(parsed.migration_run_id) !== runId ||
            this._text(parsed.staged_ci_id) !== stagedCiId) {
            return false;
        }

        var status = this._text(parsed.status).toLowerCase();
        if (status !== 'selected' && status !== 'completed') {
            return false;
        }

        var replay = parsed.idempotent_replay === true ||
            this._text(parsed.idempotent_replay).toLowerCase() === 'true' ||
            parsed.replay === true ||
            this._text(parsed.replay).toLowerCase() === 'true';

        if (replay) {
            return false;
        }

        if (this._text(parsed.strategy_id) !== 'normalize_known_class_alias' ||
            this._text(parsed.mapping_version) !== 'class-alias-v1' ||
            this._text(parsed.decision_source) !== 'deterministic' ||
            parseInt(parsed.retry_count, 10) !== 1 ||
            parseInt(parsed.max_retries, 10) !== 1) {
            return false;
        }

        try {
            this._validateStrategyEvidence(parsed);
            return true;
        } catch (error) {
            return false;
        }
    },

    _validateStrategyEvidence: function(evidence) {
        if (!evidence || typeof evidence !== 'object') {
            throw new Error('Structured strategy evidence is required');
        }

        var reconstructed = new DotwalkersFailureStrategyService().reconstruct(evidence);

        if (parseInt(evidence.retry_count, 10) !== reconstructed.retry_count ||
            reconstructed.retry_count !== 1) {
            throw new Error('Strategy retry_count must be exactly 1');
        }

        if (parseInt(evidence.max_retries, 10) !== reconstructed.max_retries ||
            reconstructed.max_retries !== 1) {
            throw new Error('Strategy max_retries must be exactly 1');
        }

        return reconstructed;
    },

    _strategyEvidenceKey: function(evidence) {
        return JSON.stringify({
            strategy_id: this._text(evidence.strategy_id),
            mapping_version: this._text(evidence.mapping_version),
            source_class: this._text(evidence.source_class),
            target_class: this._text(evidence.target_class),
            retry_count: parseInt(evidence.retry_count, 10),
            max_retries: parseInt(evidence.max_retries, 10)
        });
    },

    _loadRun: function(runId) {
        var record = new GlideRecord(this.RUN_TABLE);

        record.addQuery('sys_id', runId);
        record.addQuery('team_prefix', this.TEAM);
        record.setLimit(1);
        record.query();

        if (!record.next()) {
            var runError = new Error('Migration Run not found.');
            runError.error_code = 'RUN_NOT_FOUND';
            throw runError;
        }

        return record;
    },

    _loadStagedCi: function(runId, stagedCiId) {
        var record = new GlideRecord(this.CI_TABLE);

        record.addQuery('sys_id', stagedCiId);
        record.addQuery('migration_run', runId);
        record.addQuery('team_prefix', this.TEAM);
        record.setLimit(1);
        record.query();

        if (!record.next()) {
            var stagedError = new Error('Staged CI not found in run.');
            stagedError.error_code = 'STAGED_CI_NOT_FOUND';
            throw stagedError;
        }

        return record;
    },

    _validateRun: function(run) {
        var state = this._text(run.getValue('state'));

        if (state !== 'awaiting_approval' && state !== 'simulated') {
            var stateError = new Error(
                'Run state does not allow simulation: ' + state
            );
            stateError.error_code = 'RUN_STATE_INVALID';
            throw stateError;
        }
    },

    _validateCandidate: function(staged) {
        var status = this._text(staged.getValue('identification_status'));

        if (status === 'conflict' || status === 'rejected') {
            var statusError = new Error('Held staged CI cannot be simulated.');
            statusError.error_code = 'CANDIDATE_REJECTED';
            throw statusError;
        }

        var confidence = this._integer(staged.getValue('confidence'));

        if (confidence < this.MIN_CONFIDENCE) {
            var confidenceError = new Error(
                'Confidence below threshold. ' +
                confidence + ' < ' + this.MIN_CONFIDENCE
            );
            confidenceError.error_code = 'CANDIDATE_REJECTED';
            throw confidenceError;
        }
    },

    _validateClass: function(className) {
        if (!this.ALLOWED_CLASSES[className]) {
            var allowlistError = new Error('Class is not allowlisted: ' + className);
            allowlistError.error_code = 'CLASS_NOT_ALLOWED';
            throw allowlistError;
        }

        var target = new GlideRecord(className);

        if (!target.isValid() || !target.isValidField('sys_class_name')) {
            var classError = new Error('Invalid CMDB class: ' + className);
            classError.error_code = 'CLASS_INVALID';
            throw classError;
        }
    },

    _resolveReference: function(
        target, values, omitted,
        targetField, referenceTable, displayField, displayValue
    ) {
        displayValue = this._text(displayValue);

        if (!displayValue) {
            return;
        }

        if (!target.isValidField(targetField)) {
            omitted.push({
                field: targetField,
                source_value: displayValue,
                reason: 'Field unavailable on class.'
            });
            return;
        }

        var reference = new GlideRecord(referenceTable);
        reference.addQuery(displayField, displayValue);

        if (reference.isValidField('active')) {
            reference.addQuery('active', true);
        }

        reference.setLimit(2);
        reference.query();

        var matches = [];

        while (reference.next()) {
            matches.push(String(reference.getUniqueValue()));
        }

        if (matches.length !== 1) {
            omitted.push({
                field: targetField,
                source_value: displayValue,
                reason: matches.length === 0
                    ? 'No exact reference match.'
                    : 'Ambiguous reference match.'
            });
            return;
        }

        values[targetField] = matches[0];
    },

    _parseObject: function(value) {
        try {
            var parsed = JSON.parse(String(value || '{}'));

            if (
                !parsed ||
                typeof parsed !== 'object' ||
                Object.prototype.toString.call(parsed) === '[object Array]'
            ) {
                throw new Error('Payload is not an object.');
            }

            return parsed;
        } catch (error) {
            throw new Error(
                'Invalid staged payload JSON: ' +
                (error && error.message ? error.message : String(error))
            );
        }
    },

    _sha256: function(value) {
        return String(
            new GlideDigest().getSHA256Hex(String(value || ''))
        );
    },

    _csvSet: function(value) {
        var result = {};
        var parts = String(value || '').split(',');

        for (var index = 0; index < parts.length; index++) {
            var item = this._text(parts[index]);
            if (item) {
                result[item] = true;
            }
        }

        return result;
    },

    _requireSysId: function(value, label) {
        value = this._text(value);

        if (!this._isSysId(value)) {
            throw new Error(label + ' must be a valid sys_id.');
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

    _text: function(value) {
        if (value === undefined || value === null || String(value) === 'null') {
            return '';
        }
        return String(value).trim();
    },

    type: 'DotwalkersIrePayloadService'
};

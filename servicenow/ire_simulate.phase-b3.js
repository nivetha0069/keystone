(function process(request, response) {
    // ──────────────────────────────────────────────────────────────────
    // Phase B3B: Thin REST adapter over DotwalkersIreSimulationService.simulate()
    //
    // This adapter:
    //   1. Reads request.body.data
    //   2. Returns HTTP 400 for a missing or unparseable body
    //   3. Instantiates DotwalkersIreSimulationService
    //   4. Calls simulate(body, { mode: 'interactive' }) exactly once
    //   5. Passes the original body unchanged — does not add trusted fields
    //   6. Maps the service result into the compatibility response envelope
    //   7. Uses result.http_status for expected service failures (not exposed in JSON)
    //   8. Returns HTTP 200 for successful simulation and idempotent replay
    //   9. Returns sanitized HTTP 500 for unexpected exceptions
    //
    // Contains no: GlideRecord, GlideAggregate, sn_cmdb, IdentificationEngine,
    // DotwalkersIrePayloadService, fingerprint logic, class mapping, retry
    // decisions, Event Ledger reads/writes, createOrUpdateCI, approval,
    // eventQueue, Execute, or Verify calls, or CMDB writes.
    // ──────────────────────────────────────────────────────────────────

    // ── Step 1: Read and validate body presence ──
    var body = request.body ? request.body.data : null;
    if (!body) {
        response.setStatus(400);
        response.setBody({
            success: false,
            action: 'simulate',
            state: 'not_simulated',
            correlation_id: '',
            idempotency_key: '',
            error: {
                code: 'INVALID_REQUEST',
                message: 'Invalid request body',
                details: ['Unable to parse request body']
            }
        });
        return;
    }

    // ── Step 2: Delegate to the shared service ──
    try {
        var svc = new DotwalkersIreSimulationService();
        var result = svc.simulate(body, { mode: 'interactive' });

        // ── Step 3a: Expected service failure (structured error) ──
        if (result && result.success === false) {
            var httpStatus = result.http_status || 500;
            response.setStatus(httpStatus);
            response.setBody({
                success: false,
                action: 'simulate',
                state: result.state || 'not_simulated',
                correlation_id: result.correlation_id || '',
                idempotency_key: result.idempotency_key || '',
                error: {
                    code: result.code || 'SERVICE_ERROR',
                    message: result.message || 'Simulation failed',
                    details: result.details || []
                }
            });
            return;
        }

        // ── Step 3b: Successful simulation or idempotent replay ──
        response.setStatus(200);
        var envelope = {
            success: true,
            action: 'simulate',
            state: result.state || 'simulated_pending_approval',
            migration_run_id: result.migration_run_id || '',
            staged_ci_id: result.staged_ci_id || '',
            correlation_id: result.correlation_id || '',
            idempotency_key: result.idempotency_key || '',
            simulation_correlation_id: result.simulation_correlation_id || '',
            simulation_fingerprint: result.simulation_fingerprint || '',
            operation: result.operation || '',
            simulation_matched_ci: result.simulation_matched_ci || ''
        };

        // Preserve optional compatibility fields when service returns them
        if (result.hasOwnProperty('finding_id')) {
            envelope.finding_id = result.finding_id;
        }
        if (result.hasOwnProperty('proposed_class')) {
            envelope.proposed_class = result.proposed_class;
        }
        if (result.hasOwnProperty('idempotent_replay')) {
            envelope.idempotent_replay = result.idempotent_replay;
        }
        if (result.hasOwnProperty('cmdb_committed')) {
            envelope.cmdb_committed = result.cmdb_committed;
        }
        if (result.hasOwnProperty('playback_event_ids')) {
            envelope.playback_event_ids = result.playback_event_ids;
        }
        if (result.hasOwnProperty('status')) {
            envelope.status = result.status;
        }
        if (result.hasOwnProperty('finding')) {
            envelope.finding = result.finding;
        }
        if (result.hasOwnProperty('matched_ci')) {
            envelope.matched_ci = result.matched_ci;
        }
        if (result.hasOwnProperty('evidence')) {
            envelope.evidence = result.evidence;
        }

        // Preserve compact strategy evidence when present
        if (result.hasOwnProperty('strategy_id')) {
            envelope.strategy_id = result.strategy_id;
        }
        if (result.hasOwnProperty('mapping_version')) {
            envelope.mapping_version = result.mapping_version;
        }
        if (result.hasOwnProperty('source_class')) {
            envelope.source_class = result.source_class;
        }
        if (result.hasOwnProperty('target_class')) {
            envelope.target_class = result.target_class;
        }
        if (result.hasOwnProperty('retry_count')) {
            envelope.retry_count = result.retry_count;
        }
        if (result.hasOwnProperty('max_retries')) {
            envelope.max_retries = result.max_retries;
        }
        if (result.hasOwnProperty('decision_source')) {
            envelope.decision_source = result.decision_source;
        }
        if (result.hasOwnProperty('work_group_signature')) {
            envelope.work_group_signature = result.work_group_signature;
        }

        envelope.error = null;
        response.setBody(envelope);

    } catch (e) {
        // ── Step 4: Unexpected exception — sanitized 500 ──
        // Static log only: no exception message, stack, payload, identifiers,
        // class values, strategy evidence, fingerprint, or credentials.
        gs.error('ire_simulate adapter encountered an unexpected service failure.');
        response.setStatus(500);
        response.setBody({
            success: false,
            action: 'simulate',
            state: 'simulation_failed',
            correlation_id: '',
            idempotency_key: '',
            error: {
                code: 'INTERNAL_ERROR',
                message: 'An unexpected error occurred',
                details: []
            }
        });
    }
})(request, response);

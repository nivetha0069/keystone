/**
 * Scripted REST Resource: usage (GET)
 * API: cmdb_bridge   (scope x_kest_dotwalkers)
 * Full path: GET /api/x_kest_dotwalkers/cmdb_bridge/usage?run=<migration_run_sys_id>
 *
 * Returns normalized per-call AI usage for one Migration Run.
 * Never returns credentials, prompts, responses, hidden reasoning, raw provider
 * payloads, or system properties.
 *
 * Status codes:
 *   400  missing "run"
 *   404  run not found
 *   403  run belongs to a different team_prefix
 *   200  success (calls may be [])
 *   500  unexpected server error
 *
 * Paste this as the "Script" of the resource. `request` and `response` are
 * provided by the Scripted REST framework.
 */
(function process(request, response) {
	var TEAM = 'THE_DOTWALKERS';

	function send(status, body) {
		response.setStatus(status);
		response.setHeader('Content-Type', 'application/json');
		response.getStreamWriter().writeString(JSON.stringify(body));
	}

	try {
		var runId = request.queryParams.run;
		if (runId && runId.length) {
			runId = ('' + runId[0]).trim();
		} else {
			runId = '';
		}

		// 400 — missing run
		if (!runId) {
			return send(400, { error: 'Query parameter "run" is required.' });
		}

		// 404 — invalid run
		var run = new GlideRecord('x_kest_dotwalkers_migration_run');
		if (!run.get(runId)) {
			return send(404, { error: 'Migration run not found.', runId: runId });
		}

		// 403 — wrong team partition
		var runTeam = ('' + run.getValue('team_prefix')).trim();
		if (runTeam && runTeam !== TEAM) {
			return send(403, { error: 'Migration run belongs to a different team.', runId: runId });
		}

		var svc = new x_kest_dotwalkers.DotwalkersAIUsageService();
		var calls = svc.listForRun(runId);
		var totals = svc.summarize(calls);

		var body = {
			runId: runId,
			calls: calls,
			totals: totals
		};

		// Honest, concise signal for runs that predate usage capture.
		if (!calls.length) {
			body.unavailableReason = 'No usage records were captured for this run.';
		}

		return send(200, body);
	} catch (e) {
		gs.error('[cmdb_bridge/usage] unexpected error: ' + (e && e.message ? e.message : e));
		return send(500, { error: 'Unexpected server error while reading AI usage.' });
	}
})(request, response);

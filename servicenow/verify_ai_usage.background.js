/**
 * Background Script — create/verify AI usage records for a Migration Run.
 * Run in: System Definition > Scripts - Background, scope x_kest_dotwalkers.
 *
 * Behavior:
 *   - If RUN_SYS_ID is set, verifies existing usage for that run (read-only).
 *   - If RUN_SYS_ID is empty, creates a fresh migration run, writes three
 *     synthetic verification rows (Comprehend success, Mara success,
 *     Prioritize fallback), then reads them back.
 *
 * The synthetic rows exercise the pipeline; they are NOT a backfill of real
 * historical usage. Only run the create branch against a throwaway run.
 */
(function () {
	var RUN_SYS_ID = ''; // <- set to verify an existing run; leave empty to create one
	var TEAM = 'THE_DOTWALKERS';
	var svc = new x_kest_dotwalkers.DotwalkersAIUsageService();

	var runId = RUN_SYS_ID;

	if (!runId) {
		var run = new GlideRecord('x_kest_dotwalkers_migration_run');
		run.initialize();
		run.setValue('summary', 'AI usage verification run');
		run.setValue('team_prefix', TEAM);
		run.setValue('state', 'analyzing');
		runId = run.insert();
		gs.info('[verify_ai_usage] created migration run: ' + runId);

		// Synthetic verification calls (clearly marked test data).
		svc.recordCall({
			migration_run_id: runId, phase: 'Comprehend', model: 'claude-sonnet-4-6',
			input_tokens: 100, output_tokens: 20, duration_ms: 900,
			status: 'success', provider_request_id: 'verify-comprehend-1'
		});
		svc.recordCall({
			migration_run_id: runId, phase: 'Mara', model: 'claude-sonnet-4-6',
			input_tokens: 250, output_tokens: 80, duration_ms: 1400,
			status: 'success', provider_request_id: 'verify-mara-1'
		});
		// Fallback: no model tokens, reason recorded, not counted as success.
		svc.recordCall({
			migration_run_id: runId, phase: 'Prioritize', model: 'claude-sonnet-4-6',
			input_tokens: 0, output_tokens: 0, duration_ms: 5,
			status: 'fallback', fallback_reason: 'Model unavailable; deterministic priority used.'
		});
	}

	var calls = svc.listForRun(runId);
	var totals = svc.summarize(calls);
	gs.info('[verify_ai_usage] runId=' + runId);
	gs.info('[verify_ai_usage] calls=' + JSON.stringify(calls, null, 2));
	gs.info('[verify_ai_usage] totals=' + JSON.stringify(totals));
})();

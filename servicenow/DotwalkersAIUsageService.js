/**
 * DotwalkersAIUsageService
 * Scope: x_kest_dotwalkers
 * Type: Script Include (server-side, "Accessible from: This application scope only")
 *
 * Records and reads AI model usage for a single Migration Run.
 * One record is written per attempted model call (success, fallback, or error).
 *
 * Storage: x_kest_dotwalkers_ai_usage (see docs/ai-usage-backend.md for the field spec).
 *
 * Design rules enforced here:
 *   - team_prefix is always forced to THE_DOTWALKERS (partition marker, not auth).
 *   - numeric values are normalized to non-negative integers; missing/invalid -> 0.
 *   - total_tokens is at least input_tokens + output_tokens.
 *   - recordCall never throws into the orchestration; it logs its own error and returns null.
 *   - no prompts, responses, credentials, or raw provider payloads are stored.
 */
var DotwalkersAIUsageService = Class.create();

DotwalkersAIUsageService.TABLE = 'x_kest_dotwalkers_ai_usage';
DotwalkersAIUsageService.RUN_TABLE = 'x_kest_dotwalkers_migration_run';
DotwalkersAIUsageService.TEAM = 'THE_DOTWALKERS';
DotwalkersAIUsageService.PHASES = { comprehend: 'Comprehend', mara: 'Mara', prioritize: 'Prioritize' };
DotwalkersAIUsageService.STATUSES = { success: 'success', fallback: 'fallback', error: 'error' };

DotwalkersAIUsageService.prototype = {
	initialize: function () {},

	/**
	 * Record one attempted model call.
	 * @param {Object} data
	 *   migration_run_id     {String}  required, sys_id of x_kest_dotwalkers_migration_run
	 *   phase                {String}  Comprehend | Mara | Prioritize
	 *   model                {String}  configured/actual model id
	 *   input_tokens         {Number}  from real provider metadata only, else 0
	 *   output_tokens        {Number}  from real provider metadata only, else 0
	 *   total_tokens         {Number}  optional; recalculated to >= input+output
	 *   duration_ms          {Number}  measured server-side
	 *   status               {String}  success | fallback | error
	 *   fallback_reason      {String}  optional, sanitized short reason
	 *   provider_request_id  {String}  optional provider correlation id
	 * @returns {String|null} sys_id of the created usage record, or null on any failure.
	 */
	recordCall: function (data) {
		try {
			data = data || {};

			var runId = this._str(data.migration_run_id);
			if (!runId || !this._runExists(runId)) {
				gs.error('[DotwalkersAIUsageService] recordCall skipped: invalid migration run "' + runId + '"');
				return null;
			}

			var input = this._nonNegInt(data.input_tokens);
			var output = this._nonNegInt(data.output_tokens);
			var total = Math.max(this._nonNegInt(data.total_tokens), input + output);

			var gr = new GlideRecord(DotwalkersAIUsageService.TABLE);
			gr.initialize();
			gr.setValue('migration_run', runId);
			gr.setValue('team_prefix', DotwalkersAIUsageService.TEAM);
			gr.setValue('phase', this._phase(data.phase));
			gr.setValue('model', this._str(data.model) || 'unknown');
			gr.setValue('input_tokens', input);
			gr.setValue('output_tokens', output);
			gr.setValue('total_tokens', total);
			gr.setValue('duration_ms', this._nonNegInt(data.duration_ms));
			gr.setValue('status', this._status(data.status));
			gr.setValue('fallback_reason', this._sanitize(data.fallback_reason));
			gr.setValue('provider_request_id', this._str(data.provider_request_id));
			gr.setValue('created', new GlideDateTime());

			return gr.insert() || null;
		} catch (e) {
			// Never break the caller's orchestration because usage logging failed.
			gs.error('[DotwalkersAIUsageService] recordCall failed: ' + (e && e.message ? e.message : e));
			return null;
		}
	},

	/**
	 * Return all usage rows for a run, oldest first, as normalized plain objects.
	 * @param {String} runId sys_id of the migration run.
	 * @returns {Array<Object>} camelCase call objects matching the /usage contract.
	 */
	listForRun: function (runId) {
		var calls = [];
		runId = this._str(runId);
		if (!runId) {
			return calls;
		}
		try {
			var gr = new GlideRecord(DotwalkersAIUsageService.TABLE);
			gr.addQuery('migration_run', runId);
			gr.addQuery('team_prefix', DotwalkersAIUsageService.TEAM);
			gr.orderBy('created');
			gr.orderBy('sys_created_on');
			gr.query();
			while (gr.next()) {
				calls.push({
					id: gr.getUniqueValue(),
					timestamp: gr.getValue('created') || gr.getValue('sys_created_on'),
					phase: gr.getValue('phase'),
					model: gr.getValue('model'),
					inputTokens: this._nonNegInt(gr.getValue('input_tokens')),
					outputTokens: this._nonNegInt(gr.getValue('output_tokens')),
					totalTokens: this._nonNegInt(gr.getValue('total_tokens')),
					durationMs: this._nonNegInt(gr.getValue('duration_ms')),
					status: gr.getValue('status')
				});
			}
		} catch (e) {
			gs.error('[DotwalkersAIUsageService] listForRun failed: ' + (e && e.message ? e.message : e));
		}
		return calls;
	},

	/**
	 * Recompute totals from a list of call objects (as returned by listForRun).
	 * @param {Array<Object>} calls
	 * @returns {Object} { callCount, inputTokens, outputTokens, totalTokens, durationMs }
	 */
	summarize: function (calls) {
		var totals = { callCount: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, durationMs: 0 };
		if (!calls || !calls.length) {
			return totals;
		}
		for (var i = 0; i < calls.length; i++) {
			var c = calls[i] || {};
			totals.callCount++;
			totals.inputTokens += this._nonNegInt(c.inputTokens);
			totals.outputTokens += this._nonNegInt(c.outputTokens);
			totals.totalTokens += this._nonNegInt(c.totalTokens);
			totals.durationMs += this._nonNegInt(c.durationMs);
		}
		return totals;
	},

	// --- internal helpers ---------------------------------------------------

	_runExists: function (runId) {
		var gr = new GlideRecord(DotwalkersAIUsageService.RUN_TABLE);
		return gr.get(runId);
	},

	_nonNegInt: function (value) {
		var n = parseInt(value, 10);
		if (isNaN(n) || n < 0) {
			return 0;
		}
		return n;
	},

	_str: function (value) {
		if (value === null || value === undefined) {
			return '';
		}
		return ('' + value).trim();
	},

	_phase: function (value) {
		var key = this._str(value).toLowerCase();
		return DotwalkersAIUsageService.PHASES[key] || this._str(value) || 'Comprehend';
	},

	_status: function (value) {
		var key = this._str(value).toLowerCase();
		return DotwalkersAIUsageService.STATUSES[key] || 'success';
	},

	// Keep only a short, safe reason string. Never store stack traces or payloads.
	_sanitize: function (value) {
		var s = this._str(value);
		if (!s) {
			return '';
		}
		s = s.replace(/\s+/g, ' ');
		return s.length > 500 ? s.substring(0, 500) : s;
	},

	type: 'DotwalkersAIUsageService'
};

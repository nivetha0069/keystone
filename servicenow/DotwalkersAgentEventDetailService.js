/**
 * Builds compact Event Ledger detail without adding event_type choices.
 * Callers still write through their existing authorized ledger service.
 */
var DotwalkersAgentEventDetailService = Class.create();

DotwalkersAgentEventDetailService.prototype = {
	initialize: function () {},

	build: function (data) {
		data = data || {};
		var detail = {
			schema: 'keystone.agent.v1',
			phase: this._choice(data.phase, ['comprehend', 'prioritize', 'remediate'], 'comprehend'),
			actor: this._safe(data.actor, 80),
			decision_source: this._choice(data.decision_source, ['model', 'deterministic', 'deterministic_fallback'], 'deterministic'),
			action: this._safe(data.action, 100),
			status: this._choice(data.status, ['started', 'completed', 'failed', 'blocked', 'approval_required'], 'completed'),
			summary: this._safe(data.summary, 300)
		};
		this._optional(detail, data, [
			'migration_run_id', 'staged_ci_id', 'finding_id', 'strategy_id', 'correlation_id',
			'simulation_correlation_id', 'execution_correlation_id',
			'simulation_fingerprint', 'mapping_version', 'target_ci_sys_id',
			'idempotency_key', 'work_group_signature', 'operation',
			'simulation_matched_ci'
		]);
		this._optionalNumber(detail, data, [
			'retry_count', 'max_retries', 'baseline_score', 'verified_score',
			'projected_score', 'health_impact'
		]);
		return JSON.stringify(detail);
	},

	_optionalNumber: function (target, source, keys) {
		for (var i = 0; i < keys.length; i++) {
			var value = source[keys[i]];
			if (value !== undefined && value !== null && value !== '' && !isNaN(Number(value))) {
				target[keys[i]] = Math.round(Number(value) * 10) / 10;
			}
		}
	},

	_optional: function (target, source, keys) {
		for (var i = 0; i < keys.length; i++) {
			var value = this._safe(source[keys[i]], 180);
			if (value) target[keys[i]] = value;
		}
	},

	_choice: function (value, allowed, fallback) {
		value = this._safe(value, 60).toLowerCase();
		return allowed.indexOf(value) >= 0 ? value : fallback;
	},

	_safe: function (value, max) {
		if (value === null || value === undefined) return '';
		return ('' + value).replace(/\s+/g, ' ').trim().substring(0, max);
	},

	type: 'DotwalkersAgentEventDetailService'
};

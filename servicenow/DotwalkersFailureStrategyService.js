/**
 * Deterministic failure grouping and allowlisted retry strategy.
 * Server-side only. This service performs no table or CMDB writes.
 */
var DotwalkersFailureStrategyService = Class.create();

DotwalkersFailureStrategyService.MAPPING_VERSION = 'class-alias-v1';
DotwalkersFailureStrategyService.CLASS_ALIASES = {
	'linux srv': 'cmdb_ci_linux_server',
	'linux server': 'cmdb_ci_linux_server',
	'windows srv': 'cmdb_ci_win_server',
	'windows server': 'cmdb_ci_win_server'
};

DotwalkersFailureStrategyService.prototype = {
	initialize: function () {},

	group: function (failure) {
		failure = failure || {};
		var errorCode = this._token(failure.error_code || failure.code || 'UNKNOWN');
		var targetClass = this._token(failure.target_class || failure.proposed_class || 'unclassified');
		var field = this._token(failure.field || this._inferField(failure.message) || 'general');
		return {
			signature: errorCode + ':' + targetClass + ':' + field,
			error_code: errorCode,
			target_class: targetClass,
			field: field
		};
	},

	decide: function (failure, retryCount) {
		var group = this.group(failure);
		var sourceClass = this._str(failure && (failure.source_class || failure.proposed_class));
		var mappedClass = DotwalkersFailureStrategyService.CLASS_ALIASES[sourceClass.toLowerCase()];
		if (parseInt(retryCount, 10) >= 1) return this._blocked(group, 'Retry limit reached');
		if (!mappedClass) return this._blocked(group, 'No allowlisted deterministic strategy');
		return {
			signature: group.signature,
			decision_source: 'deterministic',
			status: 'selected',
			strategy_id: 'normalize_known_class_alias',
			mapping_version: DotwalkersFailureStrategyService.MAPPING_VERSION,
			source_class: sourceClass,
			target_class: mappedClass,
			max_retries: 1
		};
	},

	fingerprintMaterial: function (decision) {
		if (!decision || decision.status !== 'selected') throw new Error('A selected deterministic strategy is required');
		return [
			this._token(decision.strategy_id),
			this._token(decision.mapping_version),
			this._token(decision.source_class),
			this._token(decision.target_class)
		].join('|');
	},

	_blocked: function (group, reason) {
		return {
			signature: group.signature,
			decision_source: 'deterministic',
			status: 'blocked',
			blocker: reason,
			max_retries: 1
		};
	},

	_inferField: function (message) {
		var match = this._str(message).toLowerCase().match(/\b(serial_number|serial|fqdn|host_name|hostname|ip_address|class)\b/);
		return match ? match[1] : '';
	},

	_token: function (value) {
		return this._str(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').substring(0, 100);
	},

	_str: function (value) {
		return value === null || value === undefined ? '' : ('' + value).trim();
	},

	type: 'DotwalkersFailureStrategyService'
};

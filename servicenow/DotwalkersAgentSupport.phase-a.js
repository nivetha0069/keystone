var DotwalkersAgentSupport = Class.create();

DotwalkersAgentSupport.prototype = {

    initialize: function(runId) {
        this.runId = runId || '';
        this.TEAM = 'THE_DOTWALKERS';

        this.T = {
            run: 'x_kest_dotwalkers_migration_run',
            ci: 'x_kest_dotwalkers_staged_ci_record',
            rel: 'x_kest_dotwalkers_staged_relationship',
            find: 'x_kest_dotwalkers_finding',
            review: 'x_kest_dotwalkers_review_decision',
            ev: 'x_kest_dotwalkers_event_ledger'
        };
    },

    validateRun: function() {
        if (!this.runId) {
            return {
                valid: false,
                error: 'Migration Run sys_id is required.'
            };
        }

        var run = new GlideRecord(this.T.run);

        if (!run.get(this.runId)) {
            return {
                valid: false,
                error: 'Migration Run not found.'
            };
        }

        if (run.getValue('team_prefix') !== this.TEAM) {
            return {
                valid: false,
                error: 'Migration Run does not belong to THE_DOTWALKERS.'
            };
        }

        return {
            valid: true,
            record: run
        };
    },

    setRunState: function(state) {
        var validation = this.validateRun();

        if (!validation.valid) {
            return false;
        }

        validation.record.setValue('state', state);
        validation.record.update();

        return true;
    },

    eachCI: function(callback) {
        var ci = new GlideRecord(this.T.ci);

        ci.addQuery('migration_run', this.runId);
        ci.addQuery('team_prefix', this.TEAM);
        ci.query();

        while (ci.next()) {
            callback(ci);
        }
    },

    parseConfidence: function(value, fallback) {
        var parsed = parseInt(value, 10);

        if (isNaN(parsed)) {
            return fallback;
        }

        return Math.max(0, Math.min(100, parsed));
    },

    parsePayload: function(value) {
        if (!value) {
            return {};
        }

        try {
            var parsed = JSON.parse(value);

            if (
                parsed &&
                typeof parsed === 'object'
            ) {
                return parsed;
            }
        } catch (e) {
            gs.info(
                'DotwalkersAgentSupport: payload parsing failed. ' +
                e.message
            );
        }

        return {};
    },

    payloadValue: function(payload, key) {
        if (
            payload &&
            payload[key] !== undefined &&
            payload[key] !== null &&
            String(payload[key]).trim() !== ''
        ) {
            return payload[key];
        }

        var normalized =
            payload &&
            payload.normalized_row_json;

        if (
            normalized &&
            normalized[key] !== undefined &&
            normalized[key] !== null &&
            String(normalized[key]).trim() !== ''
        ) {
            return normalized[key];
        }

        return '';
    },

    ciMeta: function(ci) {
        var payload = this.parsePayload(
            ci.getValue('payload')
        );

        var name =
            this.payloadValue(payload, 'name') ||
            this.payloadValue(payload, 'host_name') ||
            this.payloadValue(payload, 'fqdn') ||
            ci.getValue('source_identifier') ||
            '';

        return {
            id: ci.getUniqueValue(),
            name: String(name),
            sourceIdentifier:
                ci.getValue('source_identifier') || '',
            payload: payload,
            confidence: this.parseConfidence(
                ci.getValue('confidence'),
                85
            )
        };
    },

    createFinding: function(
        stagedCiId,
        type,
        severity,
        recommendation
    ) {
        var finding = new GlideRecord(this.T.find);

        finding.initialize();
        finding.setValue(
            'migration_run',
            this.runId
        );

        finding.setValue(
            'team_prefix',
            this.TEAM
        );

        if (stagedCiId) {
            finding.setValue(
                'staged_ci',
                stagedCiId
            );
        }

        finding.setValue('type', type);
        finding.setValue('severity', severity);
        finding.setValue(
            'recommendation',
            String(recommendation || '')
                .substring(0, 3900)
        );

        return finding.insert();
    },

    getRunStats: function() {
        var total = 0;
        var pending = 0;
        var conflicts = 0;
        var rejected = 0;

        this.eachCI(function(ci) {
            total++;

            var status = ci.getValue(
                'identification_status'
            );

            if (status === 'pending') {
                pending++;
            }

            if (status === 'conflict') {
                conflicts++;
            }

            if (status === 'rejected') {
                rejected++;
            }
        });

        var aggregate = new GlideAggregate(
            this.T.rel
        );

        aggregate.addQuery(
            'migration_run',
            this.runId
        );

        aggregate.addQuery(
            'team_prefix',
            this.TEAM
        );

        aggregate.addAggregate('COUNT');
        aggregate.query();

        var relationships = 0;

        if (aggregate.next()) {
            relationships = parseInt(
                aggregate.getAggregate('COUNT'),
                10
            ) || 0;
        }

        return {
            success: true,
            total: total,
            pending: pending,
            conflicts: conflicts,
            rejected: rejected,
            relationships: relationships,
            observation:
                total + ' staged CIs (' +
                pending + ' pending, ' +
                conflicts + ' conflict, ' +
                rejected + ' rejected), ' +
                relationships + ' relationships.'
        };
    },

    nextSequence: function() {
        var latest =
            new GlideRecord(this.T.ev);

        latest.addQuery(
            'migration_run',
            this.runId
        );

        latest.addQuery(
            'team_prefix',
            this.TEAM
        );

        latest.orderByDesc('sequence');
        latest.setLimit(1);
        latest.query();

        if (latest.next()) {
            var maximum =
                parseInt(
                    latest.getValue('sequence'),
                    10
                );

            if (!isNaN(maximum)) {
                return maximum + 1;
            }
        }

        return 1;
    },

    log: function(eventType, actor, detail) {
        var event = new GlideRecord(this.T.ev);

        event.initialize();
        event.setValue(
            'migration_run',
            this.runId
        );

        event.setValue(
            'team_prefix',
            this.TEAM
        );

        event.setValue(
            'sequence',
            this.nextSequence()
        );

        event.setValue(
            'event_type',
            eventType
        );

        event.setValue('actor', actor);
        event.setValue(
            'detail',
            String(detail || '')
                .substring(0, 3900)
        );

        return event.insert();
    },

    /**
     * Builds compact detail with DotwalkersAgentEventDetailService
     * and delegates to the unchanged log() method.
     */
    logAutonomous: function(eventType, actor, detailData) {
        var detail = new DotwalkersAgentEventDetailService().build(detailData);
        return this.log(eventType, actor, detail);
    },

    type: 'DotwalkersAgentSupport'
};

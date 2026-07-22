var DotwalkersMaraAgent = Class.create();

DotwalkersMaraAgent.prototype = {

    initialize: function() {
        this.MAX_STEPS = 8;

        this.runId = '';
        this.support = null;
        this.tools = null;
        this.modelUsed = '';

        this.used = {};
        this.outputs = {};

        this.ALLOWED = {
            get_audit_context: true,
            audit_ledger_sequence: true,
            audit_specialist_coverage: true,
            group_findings: true,
            check_review_evidence: true,
            identify_simulation_candidates: true,
            prepare_approval_packet: true,
            finish: true
        };

        this.REQUIRED = [
            'get_audit_context',
            'audit_ledger_sequence',
            'audit_specialist_coverage',
            'group_findings',
            'check_review_evidence',
            'identify_simulation_candidates',
            'prepare_approval_packet'
        ];
    },

    run: function(migrationRunId) {
        if (!migrationRunId) {
            return {
                success: false,
                error:
                    'Migration Run sys_id is required.'
            };
        }

        this.runId =
            String(migrationRunId);

        this.support =
            new DotwalkersAgentSupport(
                this.runId
            );

        var validation =
            this.support.validateRun();

        if (!validation.valid) {
            return {
                success: false,
                error:
                    validation.error
            };
        }

        var runRecord =
            validation.record;

        if (
            runRecord.getValue(
                'team_prefix'
            ) !==
            'THE_DOTWALKERS'
        ) {
            return {
                success: false,
                error:
                    'Migration Run does not belong to THE_DOTWALKERS.'
            };
        }

        var state =
            runRecord.getValue('state');

        if (
            [
                'analyzing',
                'awaiting_approval',
                'simulated'
            ].indexOf(state) === -1
        ) {
            return {
                success: false,
                error:
                    'Mara cannot supervise a run from state: ' +
                    state
            };
        }

        if (
            this._alreadyCompleted()
        ) {
            var recoveryHandoff =
                this._hasPrioritizeCompletion()
                    ? {
                        queued: false,
                        prioritize_completed: true,
                        reason:
                            'Prioritize already completed for this run.'
                    }
                    : this._queuePrioritize(
                        runRecord,
                        'mara_recovery'
                    );

            return {
                success: true,
                already_completed: true,
                message:
                    'A completed Mara trail already exists for this run.',
                prioritize_handoff:
                    recoveryHandoff
            };
        }

        this.tools =
            new DotwalkersMaraTools(
                this.runId
            );

        this.used = {};
        this.outputs = {};
        this.modelUsed = '';

        var history = [];
        var invalidResponses = 0;

        try {
            this._log(
                'analyzed',
                'Mara',
                'Mara supervision started. Reviewing aggregate run evidence and governance boundaries.'
            );

            for (
                var step = 1;
                step <= this.MAX_STEPS;
                step++
            ) {
                var decision =
                    this._plan(history);

                if (!decision) {
                    invalidResponses++;

                    history.push({
                        observation:
                            'The previous planner response was invalid. Return one valid JSON object using an allowlisted action.'
                    });

                    if (
                        invalidResponses >= 2
                    ) {
                        this._log(
                            'analyzed',
                            'Mara',
                            'Planner response was invalid twice. Mara is completing the deterministic audit safely.'
                        );

                        break;
                    }

                    continue;
                }

                invalidResponses = 0;

                if (
                    decision.action ===
                    'finish'
                ) {
                    break;
                }

                if (
                    this.used[
                        decision.action
                    ]
                ) {
                    history.push({
                        observation:
                            'Action ' +
                            decision.action +
                            ' has already run. Select a different action.'
                    });

                    continue;
                }

                var precondition =
                    this._preconditionError(
                        decision.action
                    );

                if (precondition) {
                    history.push({
                        observation:
                            precondition
                    });

                    continue;
                }

                this._log(
                    'analyzed',
                    'Mara',
                    'Thought: ' +
                    this._safeText(
                        decision.decision,
                        600
                    ) +
                    ' | Action: ' +
                    decision.action
                );

                if (
                    decision.handoff_to
                ) {
                    this._log(
                        'analyzed',
                        'Mara',
                        'Handoff: Mara -> ' +
                        this._safeText(
                            decision.handoff_to,
                            80
                        ) +
                        ' | Action: ' +
                        decision.action
                    );
                }

                var output =
                    this.tools.execute(
                        decision.action
                    );

                this.used[
                    decision.action
                ] = true;

                this.outputs[
                    decision.action
                ] = output;

                var observation =
                    this._compactObservation(
                        output
                    );

                this._log(
                    'analyzed',
                    'Mara',
                    'Observation: ' +
                    observation
                );

                history.push({
                    decision:
                        decision.decision,

                    action:
                        decision.action,

                    observation:
                        observation
                });
            }

            /*
             * The LLM cannot omit required evidence.
             * Missing deterministic checks are completed here.
             */
            this._runMissingRequiredTools(
                history
            );

            var packet =
                this.outputs[
                    'prepare_approval_packet'
                ];

            if (!packet) {
                packet =
                    this.tools.execute(
                        'prepare_approval_packet'
                    );

                this.outputs[
                    'prepare_approval_packet'
                ] = packet;
            }

            var completionDetail =
                'Mara completed. ' +
                packet.ready_for_simulation +
                (
                    packet.ready_for_simulation === 1
                        ? ' record is'
                        : ' records are'
                ) +
                ' ready for future simulation; ' +
                packet.requires_review +
                (
                    packet.requires_review === 1
                        ? ' requires'
                        : ' require'
                ) +
                ' human review.';

            if (
                packet.approval_required
            ) {
                completionDetail +=
                    ' Approval required: ' +
                    packet.reasons.join(' ');
            }

            this._log(
                'analyzed',
                'Mara',
                completionDetail
            );

            /*
             * Prioritize is queued only after Mara completes every required
             * deterministic governance check and writes its completion event.
             */
            var prioritizeHandoff =
                this._queuePrioritize(
                    runRecord,
                    'mara_complete'
                );

            return {
                success: true,

                model:
                    this.modelUsed,

                actions:
                    this._usedActions(),

                approval_packet:
                    packet,

                prioritize_handoff:
                    prioritizeHandoff
            };

        } catch (e) {
            var message =
                e && e.message
                    ? e.message
                    : String(e);

            try {
                this._log(
                    'error',
                    'Mara',
                    'Mara failed: ' +
                    this._safeText(
                        message,
                        1200
                    )
                );
            } catch (ignored) {
                gs.error(
                    'Mara ledger failure: ' +
                    ignored.message
                );
            }

            return {
                success: false,
                error:
                    message
            };
        }
    },

    _plan: function(history) {
        var prompt =
            'You are Mara, the governance supervisor for one ServiceNow CMDB migration run.\n' +

            'You may select only one of these actions:\n' +
            'get_audit_context\n' +
            'audit_ledger_sequence\n' +
            'audit_specialist_coverage\n' +
            'group_findings\n' +
            'check_review_evidence\n' +
            'identify_simulation_candidates\n' +
            'prepare_approval_packet\n' +
            'finish\n\n' +

            'Rules:\n' +
            '1. Select get_audit_context first.\n' +
            '2. Do not repeat an action.\n' +
            '3. Use tools for calculations. Never calculate authoritative results yourself.\n' +
            '4. Do not request table names or encoded queries.\n' +
            '5. Do not request cmdb_ci or cmdb_rel_ci writes.\n' +
            '6. Do not request IRE execution.\n' +
            '7. Use concise decision summaries only. Do not reveal hidden chain-of-thought.\n' +
            '8. The server owns the migration_run_id. Never choose or modify it.\n' +

            'Return only this JSON shape:\n' +
            '{"observation":"brief current understanding",' +
            '"decision":"one concise reason for the next safe action",' +
            '"action":"allowlisted_action",' +
            '"input":{},' +
            '"handoff_to":"optional specialist name",' +
            '"approval_required":false}\n\n' +

            'Completed actions: ' +
            JSON.stringify(
                this._usedActions()
            ) +
            '\n' +

            'Recent history: ' +
            JSON.stringify(
                history.slice(-6)
            );

        try {
            var result =
                this._callMaraLLM(
                    prompt
                );

            var response =
                result &&
                result.response !==
                    undefined
                    ? result.response
                    : result;

            if (
                response &&
                typeof response ===
                    'object'
            ) {
                response =
                    JSON.stringify(
                        response
                    );
            }

            response =
                String(response || '')
                    .replace(
                        /```json|```/gi,
                        ''
                    )
                    .trim();

            if (!response) {
                return null;
            }

            var parsed =
                JSON.parse(response);

            var action =
                String(
                    parsed.action || ''
                ).toLowerCase();

            if (
                !this.ALLOWED[action]
            ) {
                return null;
            }

            return {
                observation:
                    this._safeText(
                        parsed.observation,
                        600
                    ),

                decision:
                    this._safeText(
                        parsed.decision,
                        600
                    ) ||
                    'Select the next deterministic evidence check.',

                action:
                    action,

                input: {},

                handoff_to:
                    this._safeText(
                        parsed.handoff_to,
                        80
                    ),

                approval_required:
                    parsed.approval_required ===
                    true
            };

        } catch (e) {
            gs.info(
                'DotwalkersMaraAgent planner call failed: ' +
                e.message
            );

            return null;
        }
    },

    _callMaraLLM: function(prompt) {
        var service =
            new DotwalkersUsageAwareLLMService(this.runId, 'Mara');

        var result;

        if (
            typeof service.generateForMara ===
            'function'
        ) {
            result =
                service.generateForMara(
                    prompt
                );

        } else if (
            typeof service.generate ===
            'function'
        ) {
            result =
                service.generate(
                    'mara',
                    prompt
                );

        } else {
            throw new Error(
                'DotwalkersLLMService does not expose generateForMara() or generate().'
            );
        }

        if (!result) {
            throw new Error(
                'Mara LLM returned no result.'
            );
        }

        if (
            result.success === false
        ) {
            throw new Error(
                result.error ||
                'Mara LLM call failed.'
            );
        }

        this.modelUsed =
            String(
                result.model ||
                result.configuredModel ||
                this.modelUsed ||
                ''
            );

        return {
            response:
                result.response !==
                    undefined
                    ? result.response
                    : result,

            model:
                this.modelUsed
        };
    },

    _preconditionError: function(action) {
        if (
            action !==
                'get_audit_context' &&
            !this.used
                .get_audit_context
        ) {
            return (
                'Run get_audit_context before selecting another Mara tool.'
            );
        }

        if (
            action ===
                'prepare_approval_packet'
        ) {
            var dependencies = [
                'audit_ledger_sequence',
                'audit_specialist_coverage',
                'group_findings',
                'check_review_evidence',
                'identify_simulation_candidates'
            ];

            var missing = [];

            for (
                var index = 0;
                index <
                    dependencies.length;
                index++
            ) {
                if (
                    !this.used[
                        dependencies[index]
                    ]
                ) {
                    missing.push(
                        dependencies[index]
                    );
                }
            }

            if (missing.length) {
                return (
                    'Run these checks before preparing the approval packet: ' +
                    missing.join(', ')
                );
            }
        }

        return '';
    },

    _runMissingRequiredTools: function(history) {
        for (
            var index = 0;
            index <
                this.REQUIRED.length;
            index++
        ) {
            var action =
                this.REQUIRED[index];

            if (this.used[action]) {
                continue;
            }

            this._log(
                'analyzed',
                'Mara',
                'Thought: Completing a required deterministic evidence check before finalizing. | Action: ' +
                action
            );

            var output =
                this.tools.execute(
                    action
                );

            this.used[action] = true;
            this.outputs[action] =
                output;

            var observation =
                this._compactObservation(
                    output
                );

            this._log(
                'analyzed',
                'Mara',
                'Observation: ' +
                observation
            );

            history.push({
                decision:
                    'Required deterministic completion step.',

                action:
                    action,

                observation:
                    observation
            });
        }
    },

    _alreadyCompleted: function() {
        var gr =
            new GlideRecord(
                'x_kest_dotwalkers_event_ledger'
            );

        gr.addQuery(
            'migration_run',
            this.runId
        );

        gr.addQuery(
            'team_prefix',
            'THE_DOTWALKERS'
        );

        gr.addQuery(
            'actor',
            'Mara'
        );

        gr.addQuery(
            'detail',
            'STARTSWITH',
            'Mara completed.'
        );

        gr.setLimit(1);
        gr.query();

        return gr.hasNext();
    },

    _log: function(
        eventType,
        actor,
        detail
    ) {
        return this.support.log(
            eventType,
            actor,
            this._safeText(
                detail,
                3900
            )
        );
    },

    _compactObservation: function(output) {
        var value =
            JSON.stringify(
                output || {}
            );

        return this._safeText(
            value,
            1200
        );
    },

    _safeText: function(
        value,
        limit
    ) {
        return String(
            value || ''
        ).substring(
            0,
            limit || 1000
        );
    },

    _usedActions: function() {
        var actions = [];

        for (
            var action in this.used
        ) {
            if (
                this.used.hasOwnProperty(
                    action
                ) &&
                this.used[action]
            ) {
                actions.push(action);
            }
        }

        return actions;
    },
    _hasPrioritizeCompletion: function() {
        var gr =
            new GlideRecord(
                'x_kest_dotwalkers_event_ledger'
            );

        gr.addQuery(
            'migration_run',
            this.runId
        );

        gr.addQuery(
            'team_prefix',
            'THE_DOTWALKERS'
        );

        gr.addQuery(
            'actor',
            'Prioritize'
        );

        gr.addQuery(
            'detail',
            'STARTSWITH',
            'Prioritize completed.'
        );

        gr.setLimit(1);
        gr.query();

        return gr.hasNext();
    },

    /*
     * Queues the asynchronous Prioritize stage.
     *
     * DotwalkersPrioritizeAgent owns its own idempotency guard, so a
     * recovery queue request is safe if Mara completed previously but
     * Prioritize never reached its completion event.
     */
    _queuePrioritize: function(
        runRecord,
        reason
    ) {
        if (
            !runRecord ||
            !runRecord.isValidRecord()
        ) {
            throw new Error(
                'Mara cannot queue Prioritize without a valid Migration Run record.'
            );
        }

        if (
            this._hasPrioritizeCompletion()
        ) {
            return {
                queued: false,
                prioritize_completed: true,
                reason:
                    'Prioritize already completed for this run.'
            };
        }

        var eventId =
            gs.eventQueue(
                'x_kest_dotwalkers.prioritize.requested',
                runRecord,
                this.runId,
                String(
                    reason ||
                    'mara_complete'
                )
            );

        this._log(
            'analyzed',
            'Mara',
            'Handoff: Mara -> Prioritize. Priority analysis requested.'
        );

        return {
            queued: true,
            prioritize_completed: false,
            event_id:
                String(eventId || ''),
            reason:
                String(
                    reason ||
                    'mara_complete'
                )
        };
    },

    /**
     * Phase C preparation boundary. This method accepts only the compact,
     * server-reread approval binding produced by
     * DotwalkersIreSimulationService. It intentionally does not call run(),
     * enter the LLM loop, queue Prioritize, Execute or Verify, or write CMDB.
     */
    prepareApprovalResume: function(binding) {
        if (!binding || typeof binding !== 'object' ||
            Object.prototype.toString.call(binding) === '[object Array]') {
            return { success: false, state: 'approval_resume_rejected' };
        }

        var allowed = {
            migration_run_id: true,
            staged_ci_id: true,
            finding_id: true,
            review_decision_id: true,
            correlation_id: true,
            idempotency_key: true,
            simulation_correlation_id: true,
            simulation_fingerprint: true,
            approval_event_id: true,
            decision: true,
            decision_source: true,
            decided_by: true,
            policy_approved: true
        };
        var keys = Object.keys(binding);
        for (var i = 0; i < keys.length; i++) {
            if (!allowed[keys[i]]) {
                return { success: false, state: 'approval_resume_rejected' };
            }
        }

        var sysIds = [
            binding.migration_run_id,
            binding.staged_ci_id,
            binding.finding_id,
            binding.review_decision_id,
            binding.approval_event_id,
            binding.decided_by
        ];
        for (var s = 0; s < sysIds.length; s++) {
            if (!/^[0-9a-f]{32}$/i.test(String(sysIds[s] || ''))) {
                return { success: false, state: 'approval_resume_rejected' };
            }
        }

        if (!/^[0-9a-f]{64}$/i.test(String(binding.simulation_fingerprint || '')) ||
            binding.decision !== 'approved' ||
            binding.decision_source !== 'deterministic' ||
            binding.policy_approved !== false) {
            return { success: false, state: 'approval_resume_rejected' };
        }

        return {
            success: true,
            state: 'approval_resume_prepared',
            migration_run_id: String(binding.migration_run_id),
            staged_ci_id: String(binding.staged_ci_id),
            approval_event_id: String(binding.approval_event_id),
            simulation_correlation_id: String(binding.simulation_correlation_id),
            simulation_fingerprint: String(binding.simulation_fingerprint).toUpperCase(),
            continuation_ready: true,
            executed: false,
            verified: false,
            cmdb_committed: false
        };
    },

    /**
     * Phase D deterministic continuation. The prepared token contains only
     * server-owned identifiers and canonical correlation evidence. No model,
     * prompt, payload, class, mapping, operation, target, or decision can enter
     * this method.
     */
    continueApprovalResume: function(prepared) {
        if (!prepared || typeof prepared !== 'object' ||
            Object.prototype.toString.call(prepared) === '[object Array]') {
            return { success: false, state: 'approval_resume_rejected' };
        }
        var allowed = {
            success: true,
            state: true,
            migration_run_id: true,
            staged_ci_id: true,
            approval_event_id: true,
            simulation_correlation_id: true,
            simulation_fingerprint: true,
            continuation_ready: true,
            executed: true,
            verified: true,
            cmdb_committed: true
        };
        var keys = Object.keys(prepared);
        for (var i = 0; i < keys.length; i++) {
            if (!allowed[keys[i]]) {
                return { success: false, state: 'approval_resume_rejected' };
            }
        }
        if (prepared.success !== true ||
            prepared.state !== 'approval_resume_prepared' ||
            prepared.continuation_ready !== true ||
            prepared.executed !== false ||
            prepared.verified !== false ||
            prepared.cmdb_committed !== false ||
            !/^[0-9a-f]{32}$/i.test(String(prepared.migration_run_id || '')) ||
            !/^[0-9a-f]{32}$/i.test(String(prepared.staged_ci_id || '')) ||
            !/^[0-9a-f]{32}$/i.test(String(prepared.approval_event_id || '')) ||
            !/^[0-9a-f]{64}$/i.test(String(prepared.simulation_fingerprint || ''))) {
            return { success: false, state: 'approval_resume_rejected' };
        }
        return new DotwalkersIreSimulationService().continuePreparedApproval(prepared);
    },

    type:
        'DotwalkersMaraAgent'
};

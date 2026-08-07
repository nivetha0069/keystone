/**
 * Scripted REST resource: POST /api/x_kest_dotwalkers/cmdb_bridge/mara/chat
 *
 * Mara's advisory endpoint. It answers one question about one Migration Run and
 * does nothing else — no state change, no queued event, no IRE call, no CMDB
 * write. It is the counterpart to the Keystone route /api/cmdb/mara/chat.
 *
 * Accepted body (every other field is ignored, not merged):
 *
 *   {
 *     "migration_run_id": "<32-char sys_id>",
 *     "question": "why are records held?",
 *     "mode": "advisory",
 *     "history": [{ "role": "user" | "mara", "text": "..." }],
 *     "context": { ... }        // what the browser is displaying; never trusted
 *   }
 *
 * `context` is accepted so the answer can acknowledge what the operator is
 * looking at, but nothing is read from it: every figure in the reply is
 * re-derived here from ServiceNow. A browser cannot assert a count into an
 * answer.
 *
 * `mode` must be "advisory". Rejecting anything else keeps this resource from
 * quietly acquiring a second meaning later — if a caller ever wants an action
 * mode, that has to be a deliberate change, not a body field.
 *
 * Deployment
 * ----------
 *   1. Create Script Include `DotwalkersMaraChatService` in scope
 *      x_kest_dotwalkers, "Accessible from: This application scope only",
 *      from servicenow/DotwalkersMaraChatService.js.
 *   2. On the existing Scripted REST API `cmdb_bridge`, add a resource:
 *        Name:            Mara chat
 *        HTTP method:     POST
 *        Relative path:   /mara/chat
 *        Script:          this file
 *      Requires authentication, and the same ACL/role as the other bridge
 *      resources. No new role is introduced.
 *   3. Point Keystone at it. It defaults to {CMDB_API_BASE_URL}/mara/chat, so
 *      no new variable is needed unless the path differs; if it does, set
 *      CMDB_MARA_CHAT_URL to the full URL.
 *
 * Until this resource exists, Keystone's /api/cmdb/mara/chat answers 502/503
 * and the companion keeps the answer it derived in the browser. Deploying this
 * upgrades the wording, not the truthfulness.
 */
(function process(/*RESTAPIRequest*/ request, /*RESTAPIResponse*/ response) {
    var TEAM = 'THE_DOTWALKERS';
    var RUN_TABLE = 'x_kest_dotwalkers_migration_run';
    var MAX_QUESTION = 400;
    var MAX_HISTORY = 6;
    var MAX_HISTORY_TEXT = 300;

    function send(status, payload) {
        response.setStatus(status);
        response.setHeader('Content-Type', 'application/json');
        return payload;
    }

    function isSysId(value) {
        return /^[0-9a-f]{32}$/i.test(String(value || '').trim());
    }

    function safeText(value, max) {
        if (value === null || value === undefined) {
            return '';
        }
        // Newlines are collapsed so a question cannot carry a fabricated
        // instruction block into the prompt the Script Include builds.
        var text = String(value).replace(/[\r\n\t]+/g, ' ').trim();
        return text.length > max ? text.substring(0, max) : text;
    }

    function normalizeHistory(value) {
        var turns = [];
        if (!value || !Array.isArray(value)) {
            return turns;
        }
        var start = Math.max(0, value.length - MAX_HISTORY);
        for (var i = start; i < value.length; i++) {
            var turn = value[i] || {};
            var role = turn.role === 'mara' ? 'mara' : turn.role === 'user' ? 'user' : '';
            var text = safeText(turn.text, MAX_HISTORY_TEXT);
            if (role && text) {
                turns.push({ role: role, text: text });
            }
        }
        return turns;
    }

    try {
        var body = request.body && request.body.data ? request.body.data : {};
        if (typeof body === 'string') {
            try {
                body = JSON.parse(body);
            } catch (parseError) {
                return send(400, { success: false, error: 'Request body must contain valid JSON.' });
            }
        }

        var runId = String(body.migration_run_id || body.run_id || '').trim().toLowerCase();
        if (!isSysId(runId)) {
            return send(400, { success: false, error: 'migration_run_id must be a valid 32-character sys_id.' });
        }

        var question = safeText(body.question, MAX_QUESTION);
        if (!question) {
            return send(400, { success: false, migration_run_id: runId, error: 'question is required.' });
        }

        var mode = String(body.mode || 'advisory').trim().toLowerCase();
        if (mode !== 'advisory') {
            return send(400, {
                success: false,
                migration_run_id: runId,
                error: 'This resource answers questions only. mode must be "advisory".'
            });
        }

        var run = new GlideRecord(RUN_TABLE);
        if (!run.get(runId)) {
            return send(404, { success: false, migration_run_id: runId, error: 'Migration Run was not found.' });
        }
        if (run.isValidField('team_prefix') && String(run.getValue('team_prefix') || '') !== TEAM) {
            return send(403, { success: false, migration_run_id: runId, error: 'Migration Run does not belong to THE_DOTWALKERS.' });
        }
        if (typeof run.canRead === 'function' && !run.canRead()) {
            return send(403, { success: false, migration_run_id: runId, error: 'The authenticated user cannot read this Migration Run.' });
        }

        var result = new DotwalkersMaraChatService(runId).answer(question, normalizeHistory(body.history));
        if (!result || result.success !== true) {
            return send(422, {
                success: false,
                migration_run_id: runId,
                error: (result && result.error) || 'Mara could not answer from this run.'
            });
        }

        // The evidence the answer was composed from is returned alongside it, so
        // a reviewer can check the prose against the counts without a second
        // request. Nothing here is browser-supplied.
        return send(200, {
            success: true,
            migration_run_id: runId,
            mode: 'advisory',
            answer: result.answer,
            intent: result.intent,
            decision_source: result.decision_source,
            fallback_reason: result.fallback_reason || '',
            model: result.model || '',
            run_state: result.evidence ? result.evidence.run_state : '',
            evidence: result.evidence || {}
        });
    } catch (error) {
        var message = error && error.message ? error.message : String(error);
        gs.error('[DOTWALKERS_MARA_CHAT_API] ' + message);
        return send(500, {
            success: false,
            error: 'Unable to answer from this migration run.',
            detail: message
        });
    }
})(request, response);

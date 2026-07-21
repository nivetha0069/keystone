(function process(request, response) {
    var body = request && request.body ? request.body.data : null;
    var result;

    try {
        result = new DotwalkersIreSimulationService().recordProposal(body);
    } catch (ignored) {
        result = {
            success: false,
            http_status: 500,
            state: 'simulated_pending_approval',
            code: 'PROPOSAL_FAILED',
            message: 'Proposal could not be processed',
            retryable: false,
            cmdb_committed: false
        };
    }

    response.setStatus(result.http_status || (result.success ? 200 : 500));
    response.setBody(result);
})(request, response);

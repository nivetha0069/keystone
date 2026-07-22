(function process(request, response) {
    var body = request.body ? request.body.data : null;
    var result;

    try {
        result = new DotwalkersIreSimulationService().executionStatus(body, {
            mode: 'interactive_status_only'
        });
    } catch (ignoredUnexpectedFailure) {
        gs.error('ire_execute status adapter encountered an unexpected service failure.');
        result = {
            success: false,
            http_status: 500,
            state: 'approved_for_execution',
            code: 'INTERNAL_ERROR',
            message: 'Execution status service failed'
        };
    }

    response.setStatus(result.http_status || (result.success ? 200 : 409));
    response.setBody(result);
})(request, response);

const { AsyncLocalStorage } = require('async_hooks');

// Holds the logged-in user for the request being served, so DB hooks
// (audit log) know who made a change without passing it through every controller.
const requestContext = new AsyncLocalStorage();
const currentUser = () => requestContext.getStore()?.user || null;

module.exports = { requestContext, currentUser };

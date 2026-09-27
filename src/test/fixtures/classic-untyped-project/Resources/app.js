// A classic project with no @types/titanium of its own, so the server has to fetch them.
// Only the e2e tier opens this project with the network allowed; see src/test/e2e.
const window = Ti.UI.createWindow({ backgroundColor: 'white' });
window.open();

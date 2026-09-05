// A classic project has no controllers, views or styles — just JavaScript under Resources/
const http = require('lib/http');

const window = Ti.UI.createWindow({ backgroundColor: 'white' });
window.add(Ti.UI.createImageView({ image: 'images/logo.png' }));
window.open();

http.noop();

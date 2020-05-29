/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';

const utils = require('@iobroker/adapter-core'); // Get common adapter utils
//let IOSocket      = require(utils.appName + '.socketio/lib/socket.js');
const IOSocket      = require('./lib/socket.js'); // temporary
const request       = require('request');
const AlexaSH2      = require('./lib/alexaSmartHomeV2');
const AlexaSH3      = require('./lib/alexaSmartHomeV3');
const AlexaCustom   = require('./lib/alexaCustom');
const pack          = require('./io-package.json');
const adapterName   = require('./package.json').name.split('.').pop();

let socket          = null;
let ioSocket        = null;
let recalcTimeout   = null;
let lang            = 'de';
let translate       = false;
let alexaSH2        = null;
let alexaSH3        = null;
let alexaCustom     = null;

let detectDisconnect = null;
let pingTimer       = null;
let connected       = false;
let connectTimer    = null;
let uuid            = null;
let alexaDisabled   = false;
let waiting         = false;

let TEXT_PING_TIMEOUT = 'Ping timeout';

let adapter;
function startAdapter(options) {
    options = options || {};
    Object.assign(options,{
        name:         adapterName,
        objectChange: function (id, obj) {
            if (ioSocket) {
                ioSocket.send(socket, 'objectChange', id, obj);
            }

            if (id === 'system.config' && obj && !translate) {
                lang = obj.common.language;
                if (lang !== 'en' && lang !== 'de') {
                    lang = 'en';
                }
                alexaSH2 && alexaSH2.setLanguage(lang, false);
                alexaSH3 && alexaSH3.setLanguage(lang, false);
            }
        },
        stateChange:  function (id, state) {
            if (socket) {
                if (id === adapter.namespace + '.services.ifttt' && state && !state.ack) {
                    sendDataToIFTTT({
                        id: id,
                        val: state.val,
                        ack: false
                    });
                } else {
                    if (state && !state.ack) {
                        if (id === adapter.namespace + '.smart.alexaDisabled') {
                            alexaDisabled = state.val === 'true' || state.val === true;
                            if (!alexaDisabled && !adapter.config.apikey || !adapter.config.apikey.toString().startsWith('@pro_')) {
                                adapter.setState('smart.alexaDisabled', true, true);
                            } else {
                                adapter.setState('smart.alexaDisabled', alexaDisabled, true);
                            }
                        }
                    }
                    ioSocket && ioSocket.send(socket, 'stateChange', id, state);
                }
            }
        },
        unload:       function (callback) {
            if (pingTimer) {
                clearInterval(pingTimer);
                pingTimer = null;
            }
            if (detectDisconnect) {
                clearTimeout(detectDisconnect);
                detectDisconnect = null;
            }
            try {
                if (socket) {
                    socket.close();
                }
                ioSocket = null;
                callback();
            } catch (e) {
                callback();
            }
        },
        message:      function (obj) {
            if (obj) {
                switch (obj.command) {
                    case 'update':
                        recalcTimeout && clearTimeout(recalcTimeout);

                        recalcTimeout = setTimeout(() => {
                            recalcTimeout = null;
                            alexaSH2 && alexaSH2.updateDevices(() =>
                                adapter.setState('smart.updates', true, true));

                            alexaSH3 && alexaSH3.updateDevices(() =>
                                adapter.setState('smart.updates3', true, true));
                        }, 1000);
                        break;

                    case 'browse':
                        if (obj.callback) {
                            adapter.log.info('Request devices');
                            alexaSH2 && alexaSH2.updateDevices(() => {
                                adapter.sendTo(obj.from, obj.command, alexaSH2.getDevices(), obj.callback);
                                adapter.setState('smart.updates', false, true);
                            });
                        }
                        break;

                    case 'browse3':
                        if (obj.callback) {
                            adapter.log.info('Request V3 devices');
                            alexaSH3 && alexaSH3.updateDevices(() => {
                                adapter.sendTo(obj.from, obj.command, alexaSH3.getDevices(), obj.callback);
                                adapter.setState('smart.updates3', false, true);
                            });
                        }
                        break;

                    case 'enums':
                        if (obj.callback) {
                            adapter.log.info('Request enums');
                            alexaSH2 && alexaSH2.updateDevices(() => {
                                adapter.sendTo(obj.from, obj.command, alexaSH2.getEnums(), obj.callback);
                                adapter.setState('smart.updates', false, true);
                            });
                        }
                        break;

                    case 'ifttt':
                        sendDataToIFTTT(obj.message);
                        break;

                    default:
                        adapter.log.warn('Unknown command: ' + obj.command);
                        break;
                }
            }
        },
        ready:        () => createInstancesStates(main)
    });

    adapter = new utils.Adapter(options);

    return adapter;
}

function sendDataToIFTTT(obj) {
    if (!obj) {
        adapter.log.warn('No data to send to IFTTT');
        return;
    }
    if (!adapter.config.iftttKey && (typeof obj !== 'object' || !obj.key)) {
        adapter.log.warn('No IFTTT key is defined');
        return;
    }
    if (typeof obj !== 'object') {
        ioSocket.send(socket, 'ifttt', {
            id:     adapter.namespace + '.services.ifttt',
            key:    adapter.config.iftttKey,
            val:    obj
        });
    } else if (obj.event) {
        ioSocket.send(socket, 'ifttt', {
            event:  obj.event,
            key:    obj.key || adapter.config.iftttKey,
            value1: obj.value1,
            value2: obj.value2,
            value3: obj.value3
        });
    } else {
        if (obj.val === undefined) {
            adapter.log.warn('No value is defined');
            return;
        }
        obj.id = obj.id || (adapter.namespace + '.services.ifttt');
        ioSocket.send(socket, 'ifttt', {
            id:  obj.id,
            key: obj.key || adapter.config.iftttKey,
            val: obj.val,
            ack: obj.ack
        });
    }
}

function pingConnection() {
    if (!detectDisconnect) {
        if (connected && ioSocket) {
            // cannot use "ping" because reserved by socket.io
            ioSocket.send(socket, 'pingg');

            detectDisconnect = setTimeout(() => {
                detectDisconnect = null;
                adapter.log.error(TEXT_PING_TIMEOUT);
                onDisconnect(TEXT_PING_TIMEOUT);
            }, adapter.config.pingTimeout);
        }
    }
}

function checkPing() {
    if (connected) {
        pingTimer = pingTimer || setInterval(pingConnection, 30000);
    } else {
        if (pingTimer) {
            clearInterval(pingTimer);
            pingTimer = null;
        }
        if (detectDisconnect) {
            clearTimeout(detectDisconnect);
            detectDisconnect = null;
        }
    }
}

function controlState(id, data, callback) {
    id = id || 'services.ifttt';

    if (typeof data === 'object') {
        if (data.id) {
            if (data.id === adapter.namespace + '.services.ifttt') {
                data.ack = true;
            }
            if (data.val === undefined) {
                callback && callback('No value set');
                return;
            }
            adapter.getForeignObject(data.id, (err, obj) => {
                if (!obj || !obj.common) {
                    callback && callback('Unknown ID: ' + data.id);
                } else {
                    if (typeof data.val === 'string') {
                        data.val = data.val.replace(/^@ifttt\s?/, '');
                    }
                    if (obj.common.type === 'boolean') {
                        data.val = data.val === true || data.val === 'true' || data.val === 'on' || data.val === 'ON' || data.val === 1 || data.val === '1';
                    } else if (obj.common.type === 'number') {
                        data.val = parseFloat(data.val);
                    }

                    adapter.setForeignState(data.id, data.val, data.ack, callback);
                }
            });
        } else if (data.val !== undefined) {
            if (typeof data.val === 'string') {
                data.val = data.val.replace(/^@ifttt\s?/, '');
            }
            adapter.setState(id, data.val, data.ack !== undefined ? data.ack : true, callback);
        } else {
            if (typeof data === 'string') {
                data = data.replace(/^@ifttt\s?/, '');
            }
            adapter.setState(id, JSON.stringify(data), true, callback);
        }
    } else {
        if (typeof data === 'string') {
            data = data.replace(/^@ifttt\s?/, '');
        }
        adapter.setState(id, data, true, callback);
    }
}

function processIfttt(data, callback) {
    adapter.log.debug('Received IFTTT object: ' + data);
    let id;
    if (typeof data === 'object' && data.id && data.data !== undefined) {
        id = data.id;
        if (typeof data.data === 'string' && data.data[0] === '{') {
            try {
                data = JSON.parse(data.data);
            } catch (e) {
                adapter.log.debug('Cannot parse: ' + data.data);
            }
        } else {
            data = data.data;
        }
    } else {
        if (typeof data === 'string' && data[0] === '{') {
            try {
                data = JSON.parse(data);

                if (typeof data.id === 'string') {
                    id = data.id;
                    if (data.data) {
                        data = data.data;
                    }
                }
            } catch (e) {
                adapter.log.debug('Cannot parse: ' + data);
            }
        }
    }

    if (id) {
        adapter.getForeignObject(id, (err, obj) => {
            if (obj) {
                controlState(id, data, callback);
            } else {
                adapter.getForeignObject(adapter.namespace + '.services.'  + id, (err, obj) => {
                    if (!obj) {
                        // create state
                        adapter.setObject('services.' + id, {
                                type: 'state',
                                common: {
                                    name: 'IFTTT value',
                                    write: false,
                                    role: 'state',
                                    read: true,
                                    type: 'mixed',
                                    desc: 'Custom state'
                                },
                                native: {}
                            },
                            () => controlState(adapter.namespace + '.services.'  + id, data, callback));
                    } else {
                        controlState(obj._id, data, callback);
                    }
                });
            }
        });
    } else {
        controlState(null, data, callback);
    }
}

function onDisconnect(event) {
    if (typeof event === 'string') {
        adapter.log.info('Connection changed: ' + event);
    } else {
        adapter.log.info('Connection changed: disconnect');
    }

    if (connected) {
        adapter.log.info('Connection lost');
        connected = false;
        adapter.setState('info.connection', false, true);

        // clear ping timers
        checkPing();

        if (adapter.config.restartOnDisconnect) {
            // simulate scheduled restart
            setTimeout(() => adapter.terminate ? adapter.terminate(-100): process.exit(-100), 10000);
        } else {
            startConnect();
        }
    }
}

function onConnect() {
    if (!connected) {
        adapter.log.info('Connection changed: connect');
        connected = true;
        adapter.setState('info.connection', connected, true);
        checkPing();
    } else {
        adapter.log.info('Connection not changed: was connected');
    }

    if (connectTimer) {
        clearInterval(connectTimer);
        connectTimer = null;
    }
}

function onCloudConnect(clientId) {
    adapter.log.info('User accessed from cloud: ' + (clientId || ''));
    adapter.setState('info.userOnCloud', true, true);
}

function onCloudDisconnect(clientId, name) {
    adapter.log.info('User disconnected from cloud: ' + (clientId || '') + ' ' + (name || ''));
    adapter.setState('info.userOnCloud', false, true);
}

function onCloudWait(seconds) {
    waiting = true;
    adapter.log.info('Server asked to wait for ' + (seconds || 60) + ' seconds');
    if (socket) {
        socket.disconnect();
        socket.off();
        socket = null;
    }
    if (connectTimer) {
        clearInterval(connectTimer);
        connectTimer = null;
    }

    setTimeout(() => {
        waiting = false;
        startConnect(true);
    }, (seconds * 1000) || 60000);
}

function onCloudRedirect(data) {
    if (!data) {
        adapter.log.info('Received invalid redirect command from server');
        return;
    }
    if (!data.url) {
        adapter.log.error('Received redirect, but no URL.');
    } else
    if (data.notSave) {
        adapter.log.info('Adapter redirected temporally to "' + data.url + '" in one minute. Reason: ' + (data && data.reason ? data.reason : 'command from server'));
        adapter.config.cloudUrl = data.url;
        if (socket) {
            socket.disconnect();
            socket.off();
        }
        startConnect();
    } else {
        adapter.log.info('Adapter redirected continuously to "' + data.url + '". Reason: ' + (data && data.reason ? data.reason : 'command from server'));
        adapter.getForeignObject('system.adapter.' + adapter.namespace, (err, obj) => {
            if (err) adapter.log.error('redirectAdapter [getForeignObject]: ' + err);
            if (obj) {
                obj.native.cloudUrl = data.url;
                setTimeout(() => {
                    adapter.setForeignObject(obj._id, obj, err => {
                        if (err) adapter.log.error('redirectAdapter [setForeignObject]: ' + err);

                        adapter.config.cloudUrl = data.url;
                        if (socket) {
                            socket.disconnect();
                            socket.off();
                        }
                        startConnect();
                    });
                }, 3000);
            }
        });
    }
}

function onCloudError(error) {
    adapter.log.error('Cloud says: ' + error);
}

function onCloudStop(data) {
    adapter.getForeignObject('system.adapter.' + adapter.namespace, (err, obj) => {
        if (err) adapter.log.error('[getForeignObject]: ' + err);
        if (obj) {
            obj.common.enabled = false;
            setTimeout(() =>
                adapter.setForeignObject(obj._id, obj, err => {
                    if (err) adapter.log.error('[setForeignObject]: ' + err);
                    adapter.terminate ? adapter.terminate(): process.exit();
                }), 5000);
        } else {
            adapter.terminate ? adapter.terminate(): process.exit();
        }
    });
}

// this is bug of scoket.io
// sometimes auto-reconnect does not work.
function startConnect(immediately) {
    if (waiting) return;

    if (connectTimer) {
        clearInterval(connectTimer);
        connectTimer = null;
    }
    connectTimer = setInterval(connect, 60000);
    if (immediately) {
        connect();
    }
}

function initConnect(socket, options) {
    ioSocket = new IOSocket(socket, options, adapter);

    ioSocket.on('connect',         onConnect);
    ioSocket.on('disconnect',      onDisconnect);
    ioSocket.on('cloudError',      onCloudError);
    ioSocket.on('cloudConnect',    onCloudConnect);
    ioSocket.on('cloudDisconnect', onCloudDisconnect);
    ioSocket.on('connectWait',     onCloudWait);
    ioSocket.on('cloudRedirect',   onCloudRedirect);
    ioSocket.on('cloudStop',       onCloudStop);
}

function connect() {
    if (waiting) return;

    adapter.log.debug('Connection attempt to ' + (adapter.config.cloudUrl || 'https://iobroker.net:10555') + ' ...');

    if (socket) {
        socket.off();
        socket.disconnect();
    }

    socket = require('socket.io-client')(adapter.config.cloudUrl || 'https://iobroker.net:10555', {
        transports:           ['websocket'],
        autoConnect:          true,
        reconnection:         !adapter.config.restartOnDisconnect,
        rejectUnauthorized:   !adapter.config.allowSelfSignedCertificate,
        randomizationFactor:  0.9,
        reconnectionDelay:    60000,
        timeout:              parseInt(adapter.config.connectionTimeout, 10) || 10000,
        reconnectionDelayMax: 120000
    });

    socket.on('connect_error', error => adapter.log.error('Error while connecting to cloud: ' + error));

    // cannot use "pong" because reserved by socket.io
    socket.on('pongg', (/*error*/) => {
        clearTimeout(detectDisconnect);
        detectDisconnect = null;
    });

    let server      = 'http://localhost:8082';
    let adminServer = 'http://localhost:8081';

    socket.on('html', (url, cb) => {
        if (url.match(/^\/admin\//)) {
            if (adminServer && adapter.config.allowAdmin) {
                url = url.substring(6);
                request({url: adminServer + url, encoding: null}, (error, response, body) =>
                    cb(error, response ? response.statusCode : 501, response ? response.headers : [], body));
            } else {
                cb('Enable admin in cloud settings. And only pro.', 404, [], 'Enable admin in cloud settings. And only pro.');
            }
        } else if (adminServer && adapter.config.allowAdmin && url.match(/^\/adapter\/|^\/lib\/js\/ace-|^\/lib\/js\/cron\/|^\/lib\/js\/jqGrid\//)) {
            request({url: adminServer + url, encoding: null}, (error, response, body) =>
                cb(error, response ? response.statusCode : 501, response ? response.headers : [], body));
        } else if (server) {
            request({url: server + url, encoding: null}, (error, response, body) =>
                cb(error, response ? response.statusCode : 501, response ? response.headers : [], body));
        } else {
            cb('Admin or Web are inactive.', 404, [], 'Admin or Web are inactive.');
        }
    });

    socket.on('alexa', (request, callback) => {
        adapter.log.debug(new Date().getTime() + ' ALEXA: ' + JSON.stringify(request));

        if (request && request.directive) {
            alexaSH3 && alexaSH3.process(request, !alexaDisabled, callback);
        } if (request && !request.header) {
            alexaCustom && alexaCustom.process(request, !alexaDisabled, callback);
        } else {
            alexaSH2 && alexaSH2.process(request, !alexaDisabled, callback);
        }
    });

    socket.on('ifttt', processIfttt);

    socket.on('iftttError', error => adapter.log.error('Error from IFTTT: ' + JSON.stringify(error)));

    socket.on('cloudError', error => adapter.log.error('Cloud says: ' + error));

    socket.on('service', (data, callback) => {
        adapter.log.debug('service: ' + JSON.stringify(data));
        // supported services:
        // - text2command
        // - simpleApi
        // - custom, e.g. torque
        if (!data || !data.name) {
            callback && callback({error: 'no name'});
        } else
        if (data.name === 'ifttt' && adapter.config.iftttKey) {
            processIfttt(data.data, callback);
        } else {
            let isCustom = false;
            if (data.name.match(/^custom_/)) {
                data.name = data.name.substring(7);
                isCustom = true;
            }

            if (adapter.config.allowedServices[0] === '*' || adapter.config.allowedServices.indexOf(data.name) !== -1) {
                if (!isCustom && data.name === 'text2command') {
                    if (adapter.config.text2command !== undefined && adapter.config.text2command !== '') {
                        adapter.setForeignState('text2command.' + adapter.config.text2command + '.text', decodeURIComponent(data.data), err =>
                            callback && callback({result: err || 'Ok'}));
                    } else {
                        adapter.log.warn('Received service text2command, but instance is not defined');
                        callback && callback({error: 'but instance is not defined'});
                    }
                } else if (!isCustom && data.name === 'simpleApi') {
                    callback && callback({error: 'not implemented'});
                } else if (isCustom) {
                    adapter.getObject('services.custom_' + data.name, (err, obj) => {
                        if (!obj) {
                            adapter.setObject('services.custom_' + data.name, {
                                _id: adapter.namespace + '.services.custom_' + data.name,
                                type: 'state',
                                common: {
                                    name: 'Service for ' + data.name,
                                    write: false,
                                    read: true,
                                    type: 'mixed',
                                    role: 'value'
                                },
                                native: {}
                            }, err => {
                                if (!err) {
                                    adapter.setState('services.custom_' + data.name, data.data, false, err => callback && callback({result: err || 'Ok'}));
                                } else {
                                    callback && callback({result: err});
                                }
                            });
                        } else {
                            adapter.setState('services.custom_' + data.name, data.data, false, err => callback && callback({result: err || 'Ok'}));
                        }
                    });
                } else {
                    callback && callback({error: 'not allowed'});
                }
            } else {
                adapter.log.warn('Received service "' + data.name + '", but it is not found in whitelist');
                callback && callback({error: 'blocked'});
            }
        }
    });

    socket.on('error', error => startConnect());

    if (adapter.config.instance) {
        if (adapter.config.instance.substring(0, 'system.adapter.'.length) !== 'system.adapter.') {
            adapter.config.instance = 'system.adapter.' + adapter.config.instance;
        }

        adapter.getForeignObject(adapter.config.instance, (err, obj) => {
            if (obj && obj.common && obj.native) {
                if (obj.common.auth) {
                    adapter.log.error('Cannot activate web for cloud, because authentication is enabled. Please create extra instance for cloud');
                    server = '';
                    return;
                }

                server = 'http' + (obj.native.secure ? 's' : '')  + '://';
                // todo if run on other host
                server += (!obj.native.bind || obj.native.bind === '0.0.0.0') ? '127.0.0.1' : obj.native.bind;
                server += ':' + obj.native.port;

                initConnect(socket, {apikey: adapter.config.apikey, allowAdmin: adapter.config.allowAdmin, uuid: uuid, version: pack.common.version});
            } else {
                adapter.log.error('Unknown instance ' + adapter.log.instance);
                server = null;
            }
        });

        if (adapter.config.allowAdmin) {
            adapter.getForeignObject(adapter.config.allowAdmin, (err, obj) => {
                if (obj && obj.common && obj.native) {
                    if (obj.common.auth) {
                        adapter.log.error('Cannot activate admin for cloud, because authentication is enabled. Please create extra instance for cloud');
                        server = '';
                        return;
                    }
                    adminServer = 'http' + (obj.native.secure ? 's' : '') + '://';
                    // todo if run on other host
                    adminServer += (!obj.native.bind || obj.native.bind === '0.0.0.0') ? '127.0.0.1' : obj.native.bind;
                    adminServer += ':' + obj.native.port;
                } else {
                    adminServer = null;
                    adapter.log.error('Unknown instance ' + adapter.config.allowAdmin);
                }
            });
        }
    } else {
        initConnect(socket, {apikey: adapter.config.apikey, uuid: uuid, version: pack.common.version});
    }
}

function createInstancesStates(callback, objs) {
    if (!objs) {
        var pack = require(__dirname + '/io-package.json');
        objs = pack.instanceObjects;
    }
    if (!objs || !objs.length) {
        callback();
    } else {
        var obj = objs.shift();
        adapter.getObject(obj._id, (err, _obj) => {
            if (!_obj) {
                adapter.setObject(obj._id, obj, err => {
                    if (err) adapter.log.error('Cannot setObject: ' + err);
                    setImmediate(createInstancesStates, callback, objs);
                });
            } else {
                setImmediate(createInstancesStates, callback, objs);
            }
        });
    }
}

function main() {
    adapter.config.pingTimeout = parseInt(adapter.config.pingTimeout, 10) || 5000;
    if (adapter.config.pingTimeout < 3000) {
        adapter.config.pingTimeout = 3000;
    }

    if (adapter.config.deviceOffLevel === undefined) {
        adapter.config.deviceOffLevel = 30;
    }

    adapter.config.deviceOffLevel = parseFloat(adapter.config.deviceOffLevel) || 0;
    adapter.config.concatWord     = (adapter.config.concatWord || '').toString().trim();
    adapter.config.apikey         = (adapter.config.apikey || '').trim();
    adapter.config.replaces       = adapter.config.replaces ? adapter.config.replaces.split(',') : null;
    adapter.config.cloudUrl       = (adapter.config.cloudUrl || '').toString();

    if (adapter.config.apikey && adapter.config.apikey.match(/^@pro_/)) {
        if (adapter.config.cloudUrl.indexOf('https://iobroker.pro:')  === -1 &&
            adapter.config.cloudUrl.indexOf('https://iobroker.info:') === -1) {
            adapter.config.cloudUrl = 'https://iobroker.pro:10555';
        }
    } else {
        adapter.config.allowAdmin = false;
    }

    if (adapter.config.replaces) {
        let text = [];
        for (let r = 0; r < adapter.config.replaces.length; r++) {
            text.push('"' + adapter.config.replaces + '"');
        }
        adapter.log.debug('Following strings will be replaced in names: ' + text.join(', '));
    }

    // cloud could be used only together with pro.
    // All other users must use iot cloud
    if (!adapter.config.apikey || !adapter.config.apikey.toString().startsWith('@pro_')) {
        alexaSH2    = new AlexaSH2(adapter);
        alexaSH3    = new AlexaSH3(adapter);
        alexaCustom = new AlexaCustom(adapter);
        adapter.log.warn('Please use ioBroker.iot for alexa control');
    }

    // process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    adapter.getForeignObject('system.config', (err, obj) => {
        if (adapter.config.language) {
            translate = true;
            lang = adapter.config.language;
        } else {
            lang = obj.common.language;
        }
        if (lang !== 'en' && lang !== 'de' && lang !== 'ru') {
            lang = 'en';
        }
        alexaSH2 && alexaSH2.setLanguage(lang, translate);
        alexaSH2 && alexaSH2.updateDevices();
        alexaSH3 && alexaSH3.setLanguage(lang, translate);
        alexaSH3 && alexaSH3.updateDevices();
        alexaCustom && alexaCustom.setLanguage(lang);
    });

    //if (adapter.config.allowAI && false) {
    //    createAiConnection();
    //}

    adapter.config.allowedServices = (adapter.config.allowedServices || '').split(/[,\s]+/);
    for (let s = 0; s < adapter.config.allowedServices.length; s++) {
        adapter.config.allowedServices[s] = adapter.config.allowedServices[s].trim();
    }

    adapter.setState('info.connection', false, true);
    adapter.config.cloudUrl = adapter.config.cloudUrl || 'https://iobroker.net:10555';

    if (!adapter.config.apikey) {
        adapter.log.error('No api-key found. Please get one on https://iobroker.net');
        return;
    }

    if (adapter.config.iftttKey) {
        adapter.subscribeStates('services.ifttt');
        // create ifttt object
        adapter.getObject('services.ifttt', (err, obj) => {
            if (!obj) {
                adapter.setObject('services.ifttt', {
                    _id: adapter.namespace + '.services.ifttt',
                    type: 'state',
                    common: {
                        name: 'IFTTT value',
                        write: true,
                        role: 'state',
                        read: true,
                        type: 'mixed',
                        desc: 'All written data will be sent to IFTTT. If no state specified all requests from IFTTT will be saved here'
                    },
                    native: {}
                });
            }
        });
    }

    adapter.subscribeStates('smart.*');

    adapter.getState('smart.alexaDisabled', (err, state) => {
        if (!state || state.val === null || state.val === 'null') {
            // init value with false
            if (!alexaDisabled && !adapter.config.apikey || !adapter.config.apikey.toString().startsWith('@pro_')) {
                adapter.setState('smart.alexaDisabled', true, true);
            } else {
                adapter.setState('smart.alexaDisabled', alexaDisabled, true);
            }
        } else {
            alexaDisabled = state.val === true || state.val === 'true';

            if (!alexaDisabled && !adapter.config.apikey || !adapter.config.apikey.toString().startsWith('@pro_')) {
                adapter.setState('smart.alexaDisabled', true, true);
            } else {
                adapter.setState('smart.alexaDisabled', alexaDisabled, true);
            }
        }
    });

    adapter.log.info('Connecting with ' + adapter.config.cloudUrl + ' with "' + adapter.config.apikey + '"');

    adapter.getForeignObject('system.meta.uuid', (err, obj) => {
        if (obj && obj.native) {
            uuid = obj.native.uuid;
        }
        startConnect(true);
    });
}

// If started as allInOne/compact mode => return function to create instance
if (module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}

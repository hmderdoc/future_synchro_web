var mqtt_client;

// Connect to the mqtt broker and subscribe to some topics    
function mqtt_connect(topics, message_callback, log_callback) {
    var cfg = window.sbbsConfig || {};
    var _broker_addr = (typeof broker_addr !== 'undefined') ? broker_addr : cfg.mqttAddr;
    var _broker_ws_port = (typeof broker_ws_port !== 'undefined') ? broker_ws_port : cfg.mqttWsPort;
    var _broker_wss_port = (typeof broker_wss_port !== 'undefined') ? broker_wss_port : cfg.mqttWssPort;
    var _broker_username = (typeof broker_username !== 'undefined') ? broker_username : (cfg.mqttUser || '');
    var _broker_password = (typeof broker_password !== 'undefined') ? broker_password : (cfg.mqttPass || '');
    var _system_qwk_id = (typeof system_qwk_id !== 'undefined') ? system_qwk_id : cfg.mqttQwkId;

    var options = {
        keepalive: 60,
        clientId: _system_qwk_id + Math.random().toString(16).substr(2, 8),
        username: _broker_username,
        password: _broker_password,
        protocolId: 'MQTT',
        protocolVersion: 5,
        clean: true,
        reconnectPeriod: 5000,
        connectTimeout: 30 * 1000,
        will: {
            topic: 'WillMsg',
            payload: 'Connection Closed abnormally..!',
            qos: 0,
            retain: false
        },
    };

    // Use Caddy reverse-proxy path on same origin (avoids TLS cert issues with separate Mosquitto ports)
    var protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    var host = protocol + '://' + location.host + '/mqtt';

    // Set the debugging link to a modified version of the host string
    var wssLink = document.getElementById('mqtt-wss-reconnecting-link');
    if (wssLink) wssLink.href = host.replace('wss://', 'https://');

    // Connect to the mqtt broker
    log_callback('Connecting to mqtt broker (' + host + ')');
    mqtt_client = mqtt.connect(host, options);

    // Subscribe to topics on connect
    mqtt_client.on('connect', function () {
        log_callback('Connected');
        
        for (var i = 0; i < topics.length; i++) {
            mqtt_client.subscribe(topics[i], { qos: 2 });
        }

        var wsMsg = document.getElementById('mqtt-ws-reconnecting-message');
        var wssMsg = document.getElementById('mqtt-wss-reconnecting-message');
        if (wsMsg) wsMsg.style.display = 'none';
        if (wssMsg) wssMsg.style.display = 'none';
    });

    // Display an error when connection fails
    mqtt_client.on('error', function (err) {
        log_callback('Connection error: ', err);
        mqtt_client.end();
    });
    
    // Handle messages for subscribed topics
    mqtt_client.on('message', function (topic, message, packet) {
        message_callback(topic, message, packet);
    });
    
    // Display a message when the connection drops and the client is attempting to reconnect
    // Also show the debugging message if https is being used, because the sysop may need to resolve issues with their ssl cert
    mqtt_client.on('reconnect', function () {
        log_callback('Reconnecting...');
        
        if (location.protocol === 'https:') {
            var wssMsg = document.getElementById('mqtt-wss-reconnecting-message');
            if (wssMsg) wssMsg.style.display = '';
        } else {
            var wsMsg = document.getElementById('mqtt-ws-reconnecting-message');
            if (wsMsg) wsMsg.style.display = '';
        }
    });
}    

function mqtt_publish(topic, value) {
    mqtt_client.publish(topic, value, { qos: 1, retain: false });
}

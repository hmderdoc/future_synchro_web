/* ===================================================================
   Rock Star Designer  -  /js/rockstar-designer.js
   Interactive character builder for the radio visualizer.
   Self-contained preview renderer + control panel generator.
   =================================================================== */
(function () {
    'use strict';

    // -- Grab existing CHARACTERS from visualizer if loaded ---------

    // -- hex/rgb helpers --------------------------------------------
    function hexToRgb(hex) {
        hex = hex.replace('#', '');
        if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
        var n = parseInt(hex, 16);
        return ((n>>16)&255) + ',' + ((n>>8)&255) + ',' + (n&255);
    }
    function hslToHex(h, s, l) {
        h /= 360; s /= 100; l /= 100;
        var r, g, b;
        if (s === 0) { r = g = b = l; }
        else {
            function hue2rgb(p, q, t) {
                if (t < 0) t += 1; if (t > 1) t -= 1;
                if (t < 1/6) return p + (q - p) * 6 * t;
                if (t < 1/2) return q;
                if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
                return p;
            }
            var q2 = l < 0.5 ? l * (1 + s) : l + s - l * s;
            var p2 = 2 * l - q2;
            r = hue2rgb(p2, q2, h + 1/3);
            g = hue2rgb(p2, q2, h);
            b = hue2rgb(p2, q2, h - 1/3);
        }
        return '#' + [r, g, b].map(function (x) {
            var hx = Math.round(x * 255).toString(16);
            return hx.length === 1 ? '0' + hx : hx;
        }).join('');
    }
    function deepClone(obj) {
        if (obj === null || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) return obj.map(deepClone);
        var out = {};
        for (var k in obj) if (obj.hasOwnProperty(k)) out[k] = deepClone(obj[k]);
        return out;
    }

    // ==============================================================
    //  FACE PROFILES & PRESETS
    // ==============================================================
    var DEFAULT_PROFILES = {
        round: [
            [0.00,-0.76],[0.25,-0.67],[0.41,-0.54],[0.50,-0.38],[0.53,-0.20],
            [0.52,-0.03],[0.50,0.12],[0.48,0.26],[0.45,0.38],[0.40,0.48],
            [0.33,0.56],[0.22,0.62],[0.00,0.65]
        ],
        angular: [
            [0.00,-0.80],[0.22,-0.70],[0.38,-0.58],[0.48,-0.42],[0.52,-0.25],
            [0.50,-0.08],[0.46,0.08],[0.44,0.22],[0.42,0.36],[0.37,0.48],
            [0.28,0.58],[0.15,0.65],[0.00,0.68]
        ],
        blocky: [
            [0.00,-0.78],[0.24,-0.68],[0.40,-0.56],[0.50,-0.40],[0.53,-0.22],
            [0.52,-0.05],[0.50,0.10],[0.48,0.24],[0.46,0.36],[0.43,0.46],
            [0.38,0.54],[0.28,0.60],[0.00,0.63]
        ],
        chiseled: [
            [0.00,-0.82],[0.18,-0.74],[0.34,-0.64],[0.47,-0.50],[0.52,-0.36],
            [0.53,-0.22],[0.51,-0.08],[0.48,0.06],[0.46,0.18],[0.44,0.30],
            [0.42,0.40],[0.38,0.50],[0.30,0.58],[0.18,0.64],[0.00,0.67]
        ],
        wide: [
            [0.00,-0.80],[0.20,-0.72],[0.36,-0.62],[0.48,-0.48],[0.54,-0.34],
            [0.56,-0.20],[0.54,-0.06],[0.52,0.06],[0.50,0.18],[0.48,0.28],
            [0.46,0.38],[0.42,0.46],[0.36,0.54],[0.25,0.60],[0.00,0.63]
        ]
    };

    var DEFAULT_SKELETON = {
        neck:{x:0,y:0}, shoulderL:{x:-0.18,y:0.06}, shoulderR:{x:0.18,y:0.06},
        elbowL:{x:-0.24,y:0.20}, elbowR:{x:0.24,y:0.20},
        handL:{x:-0.20,y:0.32}, handR:{x:0.20,y:0.32},
        hip:{x:0,y:0.32}, hipL:{x:-0.10,y:0.32}, hipR:{x:0.10,y:0.32},
        kneeL:{x:-0.12,y:0.46}, kneeR:{x:0.12,y:0.46},
        footL:{x:-0.14,y:0.58}, footR:{x:0.14,y:0.58}
    };
    var DEFAULT_BONES = [
        ['neck','shoulderL'],['neck','shoulderR'],['shoulderL','shoulderR'],
        ['shoulderL','elbowL'],['shoulderR','elbowR'],
        ['elbowL','handL'],['elbowR','handR'],['neck','hip'],
        ['hip','hipL'],['hip','hipR'],['hipL','kneeL'],['hipR','kneeR'],
        ['kneeL','footL'],['kneeR','footR']
    ];
    var ALL_MOVES = ['idle_sway','two_step','running_man','cabbage_patch',
                     'robot','raise_the_roof','shuffle','disco_point'];

    // -- Hair generators -------------------------------------------
    function genShortSpiky(c) {
        var out = [];
        for (var i = 0; i < 8; i++) {
            var a = (i/8)*Math.PI - Math.PI/2;
            out.push({ rx: Math.sin(a)*0.20, ry: 0.46+Math.cos(a)*0.08, rz: 0.02,
                len: 0.25+Math.random()*0.15, color: c, width: 1.4, freq: i/8,
                dir: { dx: Math.sin(a)*0.5, dy: 0.8, dz: 0.3 } });
        }
        return out;
    }
    function genLongFlowing(c) {
        var out = [];
        for (var i=0;i<7;i++){var t=i/6;out.push({rx:-0.48+t*0.30,ry:0.20-t*0.10,rz:t*0.42,len:1.10-t*0.25,color:c,width:1.5,freq:t*0.42});}
        for (var j=0;j<7;j++){var t2=j/6;out.push({rx:0.48-t2*0.30,ry:0.20-t2*0.10,rz:t2*0.42,len:1.10-t2*0.25,color:c,width:1.5,freq:0.50+t2*0.42});}
        for (var k=0;k<5;k++){var t3=(k-2)/2;out.push({rx:t3*0.15,ry:0.50,rz:0.02,len:0.55,color:c,width:1.3,freq:0.2+k*0.08,dir:{dx:t3*0.30,dy:-0.60,dz:0.50}});}
        return out;
    }
    function genMohawk(c) {
        var out = [];
        for (var i=0;i<10;i++){var t=i/9;var zP=0.46-t*0.88;
            out.push({rx:0,ry:0.30+t*0.22,rz:zP,len:0.40+Math.sin(t*Math.PI)*0.30,
            color:c,width:1.8,freq:t,dir:{dx:0,dy:0.90,dz:zP>0?0.30:-0.30}});}
        return out;
    }
    function genSlickedBack(c) {
        var out = [];
        for (var i=0;i<5;i++){var t=(i-2)/2;out.push({rx:t*0.16,ry:0.32,rz:0.46,len:0.50,color:c,width:1.6,freq:0.08+i*0.07,dir:{dx:t*0.05,dy:-0.08,dz:-0.95}});}
        for (var j=0;j<3;j++){var t2=(j-1)/1.5;out.push({rx:t2*0.12,ry:0.48,rz:0.02,len:0.55,color:c,width:1.5,freq:0.20+j*0.08,dir:{dx:t2*0.06,dy:-0.08,dz:-0.95}});}
        out.push({rx:-0.46,ry:0.18,rz:0.06,len:0.35,color:c,width:1.3,freq:0.42,dir:{dx:-0.25,dy:-0.40,dz:-0.70}});
        out.push({rx:0.46,ry:0.18,rz:0.06,len:0.35,color:c,width:1.3,freq:0.50,dir:{dx:0.25,dy:-0.40,dz:-0.70}});
        out.push({rx:0,ry:0.40,rz:-0.42,len:0.42,color:c,width:1.4,freq:0.70});
        return out;
    }
    function genPigtails(c) {
        var out = [];
        [-1,1].forEach(function(s){
            for(var i=0;i<6;i++){var t=i/5;out.push({rx:s*(0.44+t*0.04),ry:0.10+t*0.08,rz:t*0.10,len:0.90+t*0.20,color:c,width:1.5,freq:s>0?0.50+t*0.08:t*0.08});}
        });
        for(var j=0;j<4;j++){var t2=(j-1.5)/2;out.push({rx:t2*0.12,ry:0.50,rz:0.02,len:0.20,color:c,width:1.2,freq:0.30+j*0.05,dir:{dx:t2*0.20,dy:-0.60,dz:0.50}});}
        return out;
    }

    var HAIR_PRESETS = { none:null, short_spiky:genShortSpiky, long_flowing:genLongFlowing,
        mohawk:genMohawk, slicked_back:genSlickedBack, pigtails:genPigtails };
    var HAT_TYPES = ['none','cowboy','baseballcap','afro'];
    var FACIAL_HAIR_TYPES = ['none','moustache'];
    var EYE_SHAPES = ['round','round_filled','square','square_filled','xeye','clippy','visor'];
    var MOUTH_TYPES = ['normal','pucker','smiley','slot'];
    var TEETH_TYPES = ['none','teeth','bucktooth'];
    var FACE_SHAPES = Object.keys(DEFAULT_PROFILES).concat('boxy');

    // ==============================================================
    //  CHARACTER STATE
    // ==============================================================
    var charState = buildDefaultChar();

    function buildDefaultChar() {
        return {
            name: '', faceShape: 'round',
            profile: deepClone(DEFAULT_PROFILES.round), ringN: 16,
            headShape: null, boxDims: { w: 0.48, h: 0.52, d: 0.28 },
            wireColor: '#33FF33', wireRGB: '51,255,51',
            accentColor: '#FFAA00', accentRGB: '255,170,0',
            eyeShape: 'round', eyeSize: 0.08, eyeSpacing: 0.18,
            eyeHeight: -0.03, eyeColor: null, eyeOutlineColor: null,
            hasEyebrows: false, eyebrowColor: '#996633',
            eyebrowWidth: 2.0, eyebrowThickness: 0.018,
            mouthType: 'normal', mouthWidth: 0.25, mouthY: -0.45, lipColor: '#FFAA00',
            teethType: 'none', teethColor: '#FFFFFF',
            hasNose: true,
            hairStyle: 'none', hairColor: '#FF55FF',
            hatType: 'none', hatColor: '#AA6622', hatBandColor: '#664411', hatText: '',
            facialHairType: 'none', facialHairColor: '#996633',
            hasEyelashes: false, eyelashLength: 0.035, eyelashColor: '#FFFF55',
            hasMascara: false,
            clothingUpper: '#4499FF', clothingSkin: '#FFCC88',
            clothingTorso: '#4499FF', clothingLower: '#8899AA',
            clothingFeet: '#CCDDFF', hasSkirt: false, bodyRainbow: false
        };
    }

    // Build a full CHARACTERS-compatible def from state
    function buildCharDef() {
        var c = charState;
        var m = { y: c.mouthY, hw: c.mouthWidth, z: c.headShape==='box' ? c.boxDims.d+0.01 : 0.46, segs: 8, teeth: false, bucktooth: false, pucker: false, smiley: false };
        if (c.mouthType === 'slot') { m.slot = true; }
        else if (c.mouthType === 'pucker') { m.pucker = true; m.segs = 12; }
        else if (c.mouthType === 'smiley') { m.smiley = true; }
        if (c.teethType === 'teeth') { m.teeth = true; m.teethColor = hexToRgb(c.teethColor); m.segs = Math.max(m.segs, 10); }
        else if (c.teethType === 'bucktooth') { m.bucktooth = true; m.bucktoothColor = hexToRgb(c.teethColor); }

        var hair = null;
        if (c.hairStyle !== 'none' && HAIR_PRESETS[c.hairStyle]) {
            hair = HAIR_PRESETS[c.hairStyle](c.hairColor);
        }

        var hat = null;
        if (c.hatType !== 'none') {
            hat = { type: c.hatType, color: c.hatColor, rgb: hexToRgb(c.hatColor) };
            if (c.hatType === 'cowboy') { hat.bandColor = c.hatBandColor; hat.bandRGB = hexToRgb(c.hatBandColor); }
            else if (c.hatType === 'baseballcap') { hat.brimColor = c.hatColor; hat.brimRGB = hexToRgb(c.hatColor); if (c.hatText) hat.text = c.hatText; }
            else if (c.hatType === 'afro') { hat.height=0.62; hat.radiusX=0.68; hat.radiusZ=0.56; hat.rings=8; hat.honeycombSegs=14; hat.fluffiness=0.05; }
        }

        var fh = null;
        if (c.facialHairType !== 'none') {
            fh = { type: c.facialHairType, color: c.facialHairColor, rgb: hexToRgb(c.facialHairColor),
                   width: 1.8, spread: 0.22, droop: 0.06, curl: 0.02 };
        }

        var def = {
            name: c.name || 'Custom Character',
            headShape: c.headShape || null,
            boxDims: c.headShape === 'box' ? deepClone(c.boxDims) : null,
            profile: c.headShape === 'box' ? deepClone(DEFAULT_PROFILES.round) : deepClone(c.profile), ringN: c.ringN,
            eyes: {
                left:  { x: -c.eyeSpacing, y: c.eyeHeight, z: c.headShape==='box' ? c.boxDims.d+0.01 : 0.46, r: c.eyeSize },
                right: { x:  c.eyeSpacing, y: c.eyeHeight, z: c.headShape==='box' ? c.boxDims.d+0.01 : 0.46, r: c.eyeSize }
            },
            eyeShape: c.eyeShape,
            eyeColor: c.eyeColor ? { hex: c.eyeColor, rgb: hexToRgb(c.eyeColor) } : null,
            eyeOutlineColor: c.eyeOutlineColor ? { hex: c.eyeOutlineColor, rgb: hexToRgb(c.eyeOutlineColor) } : null,
            mascara: c.hasMascara,
            eyelashes: c.hasEyelashes ? { count:6,length:c.eyelashLength,color:c.eyelashColor,rgb:hexToRgb(c.eyelashColor),width:1.0,reactive:true,bottom:true } : null,
            eyebrows: c.hasEyebrows ? { color:c.eyebrowColor,rgb:hexToRgb(c.eyebrowColor),width:c.eyebrowWidth,
                innerOff:{dx:0,dy:0.06,dz:0.02}, outerOff:{dx:0.12,dy:0.08,dz:0}, thickness:c.eyebrowThickness } : null,
            mouth: m,
            lipColor: c.lipColor, lipRGB: hexToRgb(c.lipColor),
            nose: c.hasNose ? (c.headShape==='box' ? {
                bridge:[[0,-0.14,c.boxDims.d+0.06],[0,-0.28,c.boxDims.d+0.09],[0,-0.32,c.boxDims.d+0.10]],
                base:[[-0.06,-0.34,c.boxDims.d+0.04],[0,-0.32,c.boxDims.d+0.10],[0.06,-0.34,c.boxDims.d+0.04]]
            } : {
                bridge:[[0,-0.14,0.54],[0,-0.28,0.57],[0,-0.32,0.58]],
                base:[[-0.06,-0.34,0.52],[0,-0.32,0.58],[0.06,-0.34,0.52]]
            }) : null,
            wireColor: c.wireColor, wireRGB: hexToRgb(c.wireColor),
            accentColor: c.accentColor, accentRGB: hexToRgb(c.accentColor),
            hair: hair, hat: hat, facialHair: fh,
            ledIndicators: null, shutter: null, chinGuard: null,
            body: {
                color: c.wireColor, rgb: hexToRgb(c.wireColor),
                skeleton: deepClone(DEFAULT_SKELETON), bones: deepClone(DEFAULT_BONES),
                lineWidth: 1.8, glowWidth: 6, scanSpeed: 0.003, moves: ALL_MOVES.slice(),
                rainbow: c.bodyRainbow,
                clothing: {
                    upper:{color:c.clothingUpper,rgb:hexToRgb(c.clothingUpper)},
                    skin:{color:c.clothingSkin,rgb:hexToRgb(c.clothingSkin)},
                    torso:{color:c.clothingTorso,rgb:hexToRgb(c.clothingTorso)},
                    lower:{color:c.clothingLower,rgb:hexToRgb(c.clothingLower)},
                    feet:{color:c.clothingFeet,rgb:hexToRgb(c.clothingFeet)}
                }
            }
        };
        if (c.hasSkirt) def.body.skirt = { hemPoints:5, hemY:0.46, hemSpread:0.18, sway:0.03, zone:'lower' };
        return def;
    }

    // -- Head-surface helpers (ported from visualizer.js) ----------
    var HAIR_SURFACE_MARGIN = 0.03;
    function getHeadRadius(profile, y) {
        if (!profile || profile.length < 2) return 0;
        var first = profile[0], last = profile[profile.length - 1];
        if (y <= first[1]) return first[0];
        if (y >= last[1])  return last[0];
        for (var i = 0; i < profile.length - 1; i++) {
            var ay = profile[i][1], by = profile[i + 1][1];
            if (y >= ay && y <= by) {
                var f = (by === ay) ? 0 : (y - ay) / (by - ay);
                return profile[i][0] + (profile[i + 1][0] - profile[i][0]) * f;
            }
        }
        return 0;
    }
    function clampOutsideHead(profile, x, y, z) {
        var headR = getHeadRadius(profile, y);
        if (headR <= 0) return { x: x, y: y, z: z };
        var radial = Math.sqrt(x * x + z * z);
        var minR = headR + HAIR_SURFACE_MARGIN;
        if (radial >= minR) return { x: x, y: y, z: z };
        if (radial < 0.001) return { x: x, y: y, z: minR };
        var scale = minR / radial;
        return { x: x * scale, y: y, z: z * scale };
    }

    // ==============================================================
    //  PREVIEW RENDERER
    // ==============================================================
    var canvas, ctx, animRAF = null;
    var headRotY = 0, breathPhase = 0, previewMouthOpen = 0, danceTime = 0;
    var previewDancing = false, previewMouthToggle = false, previewSpinning = true;

    function initPreview() {
        canvas = document.getElementById('rsd-canvas');
        if (!canvas) return;
        ctx = canvas.getContext('2d');
        sizeCanvas();
        startAnim();
        window.addEventListener('resize', sizeCanvas);
    }
    function sizeCanvas() {
        if (!canvas) return;
        var rect = canvas.getBoundingClientRect();
        var dpr = window.devicePixelRatio || 1;
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
    }
    function startAnim() { if (animRAF) return; (function loop() { animRAF = requestAnimationFrame(loop); drawPreview(); })(); }

    function drawPreview() {
        if (!ctx || !canvas) return;
        var W = canvas.width, H = canvas.height;
        ctx.clearRect(0, 0, W, H);
        var ch = buildCharDef();
        if (!ch.profile || !ch.eyes) return;

        if (previewSpinning) headRotY += 0.012;
        breathPhase += 0.02;
        danceTime += 0.016;

        var pulse = 1 + Math.sin(breathPhase) * 0.015;
        var mTarget = previewMouthToggle ? 0.6 : 0.05;
        previewMouthOpen += (mTarget - previewMouthOpen) * 0.15;

        var headR = Math.min(W, H) * 0.46;
        var cx = W * 0.5, cy = H * 0.42;
        var cosY = Math.cos(headRotY), sinY = Math.sin(headRotY);

        function proj(x, y, z) {
            var rx = x*cosY + z*sinY, rz = -x*sinY + z*cosY;
            var depth = 1 + rz * 0.3;
            return { x: cx+rx*pulse*headR*depth, y: cy-y*pulse*headR*depth, s: depth, z: rz };
        }

        ctx.lineCap = ctx.lineJoin = 'round';

        // HEAD WIREFRAME
        var prof = ch.profile, rN = ch.ringN||16;
        if (ch.headShape === 'box' && ch.boxDims) {
            // === BOX HEAD ===
            var bx = ch.boxDims, bw = bx.w, bh = bx.h, bd = bx.d;
            // 8 corners
            var ftl=proj(-bw,bh,bd), ftr=proj(bw,bh,bd), fbl=proj(-bw,-bh,bd), fbr=proj(bw,-bh,bd);
            var btl=proj(-bw,bh,-bd), btr=proj(bw,bh,-bd), bbl=proj(-bw,-bh,-bd), bbr=proj(bw,-bh,-bd);
            ctx.strokeStyle = ch.wireColor; ctx.lineWidth = 1.6;
            // Front face
            ctx.globalAlpha = 0.65;
            ctx.beginPath(); ctx.moveTo(ftl.x,ftl.y); ctx.lineTo(ftr.x,ftr.y);
            ctx.lineTo(fbr.x,fbr.y); ctx.lineTo(fbl.x,fbl.y); ctx.closePath(); ctx.stroke();
            // Back face
            ctx.globalAlpha = 0.30;
            ctx.beginPath(); ctx.moveTo(btl.x,btl.y); ctx.lineTo(btr.x,btr.y);
            ctx.lineTo(bbr.x,bbr.y); ctx.lineTo(bbl.x,bbl.y); ctx.closePath(); ctx.stroke();
            // Side edges
            ctx.globalAlpha = 0.45;
            [[ftl,btl],[ftr,btr],[fbr,bbr],[fbl,bbl]].forEach(function(e){
                ctx.beginPath(); ctx.moveTo(e[0].x,e[0].y); ctx.lineTo(e[1].x,e[1].y); ctx.stroke();
            });
            // Horizontal ribs
            ctx.globalAlpha = 0.18; ctx.lineWidth = 0.7;
            for (var ri=1; ri<6; ri++) {
                var ry = -bh + 2*bh*(ri/6);
                var rfl=proj(-bw,ry,bd), rfr=proj(bw,ry,bd), rbl=proj(-bw,ry,-bd), rbr=proj(bw,ry,-bd);
                ctx.beginPath(); ctx.moveTo(rfl.x,rfl.y); ctx.lineTo(rfr.x,rfr.y); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(rfl.x,rfl.y); ctx.lineTo(rbl.x,rbl.y); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(rfr.x,rfr.y); ctx.lineTo(rbr.x,rbr.y); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(rbl.x,rbl.y); ctx.lineTo(rbr.x,rbr.y); ctx.stroke();
            }
            // Vertical ribs
            for (var vi=1; vi<4; vi++) {
                var vx = -bw + 2*bw*(vi/4);
                var vft=proj(vx,bh,bd), vfb=proj(vx,-bh,bd), vbt=proj(vx,bh,-bd), vbb=proj(vx,-bh,-bd);
                ctx.beginPath(); ctx.moveTo(vft.x,vft.y); ctx.lineTo(vfb.x,vfb.y); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(vbt.x,vbt.y); ctx.lineTo(vbb.x,vbb.y); ctx.stroke();
            }
            for (var di=1; di<3; di++) {
                var dz = -bd + 2*bd*(di/3);
                var dlt=proj(-bw,bh,dz), dlb=proj(-bw,-bh,dz), drt=proj(bw,bh,dz), drb=proj(bw,-bh,dz);
                ctx.beginPath(); ctx.moveTo(dlt.x,dlt.y); ctx.lineTo(dlb.x,dlb.y); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(drt.x,drt.y); ctx.lineTo(drb.x,drb.y); ctx.stroke();
            }
        } else {
            // === ROUND HEAD (profile of revolution) ===
            for (var i=0; i<prof.length; i++) {
                var r = prof[i][0]*pulse, yy = prof[i][1]*pulse;
                ctx.beginPath();
                for (var j=0; j<=rN; j++) {
                    var a = (j/rN)*Math.PI*2;
                    var p = proj(Math.cos(a)*r, yy, Math.sin(a)*r);
                    j===0 ? ctx.moveTo(p.x,p.y) : ctx.lineTo(p.x,p.y);
                }
                ctx.strokeStyle = ch.wireColor; ctx.globalAlpha = 0.3+i/prof.length*0.4;
                ctx.lineWidth = 1.2; ctx.stroke();
            }
            // Meridians
            for (var mi=0; mi<rN; mi+=2) {
                var ma = (mi/rN)*Math.PI*2;
                ctx.beginPath();
                for (var mk=0; mk<prof.length; mk++) {
                    var mr=prof[mk][0]*pulse, my=prof[mk][1]*pulse;
                    var mp=proj(Math.cos(ma)*mr, my, Math.sin(ma)*mr);
                    mk===0 ? ctx.moveTo(mp.x,mp.y) : ctx.lineTo(mp.x,mp.y);
                }
                for (var mk2=prof.length-1; mk2>=0; mk2--) {
                    var mr2=prof[mk2][0]*pulse, my2=prof[mk2][1]*pulse;
                    var mp2=proj(-Math.cos(ma)*mr2, my2, -Math.sin(ma)*mr2);
                    ctx.lineTo(mp2.x,mp2.y);
                }
                ctx.strokeStyle=ch.wireColor; ctx.globalAlpha=0.15; ctx.lineWidth=0.8; ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;

        // NOSE
        if (ch.nose) {
            ctx.beginPath();
            ch.nose.bridge.forEach(function(pt,i){var p=proj(pt[0],pt[1],pt[2]);i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y);});
            ctx.strokeStyle=ch.wireColor; ctx.globalAlpha=0.5; ctx.lineWidth=1.2; ctx.stroke();
            ctx.beginPath();
            ch.nose.base.forEach(function(pt,i){var p=proj(pt[0],pt[1],pt[2]);i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y);});
            ctx.closePath(); ctx.stroke(); ctx.globalAlpha=1;
        }

        // EYES
        [ch.eyes.left, ch.eyes.right].forEach(function(eye) {
            var p = proj(eye.x, eye.y, eye.z);
            var r = eye.r * p.s * 80;
            var fill = (ch.eyeColor && ch.eyeColor.hex) || ch.wireColor;
            var outline = ch.eyeOutlineColor ? ch.eyeOutlineColor.hex : null;
            var shape = ch.eyeShape || 'round';
            ctx.save();
            if (shape === 'square_filled') {
                var sz = r*1.4;
                ctx.fillStyle = fill; ctx.shadowColor = fill; ctx.shadowBlur = r*0.6;
                ctx.fillRect(p.x-sz/2, p.y-sz/2, sz, sz);
                if (outline) { ctx.strokeStyle=outline; ctx.lineWidth=1.5; ctx.strokeRect(p.x-sz/2,p.y-sz/2,sz,sz); }
                // Pupil
                ctx.fillStyle='#000'; ctx.shadowBlur=0;
                ctx.fillRect(p.x-sz*0.18, p.y-sz*0.18, sz*0.36, sz*0.36);
            } else if (shape === 'square') {
                // Wireframe square outline (matches visualizer drawSquareEye)
                var sz = r*1.4;
                ctx.strokeStyle=fill; ctx.lineWidth=1.5; ctx.shadowColor=fill; ctx.shadowBlur=r*0.6;
                ctx.strokeRect(p.x-sz/2, p.y-sz/2, sz, sz);
                // Iris inner square
                var isz=sz*0.55;
                ctx.strokeStyle=(outline||fill); ctx.lineWidth=1.2;
                ctx.strokeRect(p.x-isz/2, p.y-isz/2, isz, isz);
                // Pupil dot
                ctx.beginPath(); ctx.arc(p.x,p.y,r*0.2,0,Math.PI*2);
                ctx.fillStyle=fill; ctx.shadowBlur=0; ctx.fill();
            } else if (shape === 'xeye') {
                var xs = r*0.9;
                ctx.strokeStyle=fill; ctx.lineWidth=2; ctx.shadowColor=fill; ctx.shadowBlur=r*0.5;
                ctx.beginPath(); ctx.moveTo(p.x-xs,p.y-xs); ctx.lineTo(p.x+xs,p.y+xs);
                ctx.moveTo(p.x+xs,p.y-xs); ctx.lineTo(p.x-xs,p.y+xs); ctx.stroke();
            } else if (shape === 'clippy') {
                // Googly eye: large white circle with free-rolling iris
                var outerR = r*1.3;
                ctx.beginPath(); ctx.arc(p.x,p.y,outerR,0,Math.PI*2);
                ctx.fillStyle='#fff'; ctx.shadowColor='#fff'; ctx.shadowBlur=outerR*0.3; ctx.fill();
                // Black iris that offsets slightly (gravity/look-direction)
                var irisR=outerR*0.55, iOff=outerR*0.15;
                ctx.beginPath(); ctx.arc(p.x+iOff,p.y+iOff,irisR,0,Math.PI*2);
                ctx.fillStyle='#111'; ctx.shadowBlur=0; ctx.fill();
                // Pupil highlight
                ctx.beginPath(); ctx.arc(p.x+iOff-irisR*0.25,p.y+iOff-irisR*0.3,irisR*0.25,0,Math.PI*2);
                ctx.fillStyle='rgba(255,255,255,0.7)'; ctx.fill();
            } else if (shape === 'visor') {
                // Single visor band spanning both eyes — only draw once
                if (eye === ch.eyes.left) {
                    var lp=proj(ch.eyes.left.x, ch.eyes.left.y, ch.eyes.left.z);
                    var rp=proj(ch.eyes.right.x, ch.eyes.right.y, ch.eyes.right.z);
                    var vH=r*0.7;
                    ctx.strokeStyle=fill; ctx.lineWidth=1.5; ctx.shadowColor=fill; ctx.shadowBlur=r*0.5;
                    ctx.strokeRect(Math.min(lp.x,rp.x)-r*0.5, p.y-vH/2, Math.abs(rp.x-lp.x)+r, vH);
                    // Visor slit
                    ctx.strokeStyle=(outline||fill); ctx.lineWidth=1;
                    ctx.beginPath(); ctx.moveTo(Math.min(lp.x,rp.x)-r*0.3,p.y); ctx.lineTo(Math.max(lp.x,rp.x)+r*0.3,p.y); ctx.stroke();
                }
            } else if (shape === 'round_filled') {
                // Filled iris with black pupil (the designer's original style)
                ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2);
                ctx.fillStyle=fill; ctx.shadowColor=fill; ctx.shadowBlur=r*0.8; ctx.fill();
                if (outline) { ctx.strokeStyle=outline; ctx.lineWidth=1.5; ctx.stroke(); }
                ctx.beginPath(); ctx.arc(p.x,p.y,r*0.35,0,Math.PI*2);
                ctx.fillStyle='#000'; ctx.shadowBlur=0; ctx.fill();
            } else {
                // round (outline/wireframe - matches visualizer drawRoundEye)
                ctx.beginPath(); ctx.arc(p.x,p.y,r,0,Math.PI*2);
                ctx.strokeStyle=fill; ctx.lineWidth=1.5; ctx.shadowColor=fill; ctx.shadowBlur=r*0.6;
                ctx.stroke();
                if (outline) { ctx.strokeStyle=outline; ctx.lineWidth=1.2; ctx.stroke(); }
                // Pupil dot (small filled)
                ctx.beginPath(); ctx.arc(p.x,p.y,r*0.25,0,Math.PI*2);
                ctx.fillStyle=fill; ctx.shadowBlur=0; ctx.fill();
            }
            if (ch.mascara) { ctx.strokeStyle='#000'; ctx.lineWidth=2; ctx.shadowBlur=0;
                ctx.beginPath(); ctx.arc(p.x,p.y,r+2,0,Math.PI*2); ctx.stroke(); }
            ctx.restore();
        });

        // EYEBROWS
        if (ch.eyebrows) {
            var eb = ch.eyebrows;
            [{e:ch.eyes.left,s:-1},{e:ch.eyes.right,s:1}].forEach(function(o) {
                var inn = proj(o.e.x+eb.innerOff.dx*o.s, o.e.y+eb.innerOff.dy, o.e.z+eb.innerOff.dz);
                var out = proj(o.e.x+eb.outerOff.dx*o.s, o.e.y+eb.outerOff.dy, o.e.z+(eb.outerOff.dz||0));
                ctx.beginPath(); ctx.moveTo(inn.x,inn.y); ctx.lineTo(out.x,out.y);
                ctx.strokeStyle=eb.color; ctx.lineWidth=eb.width; ctx.shadowColor=eb.color; ctx.shadowBlur=3; ctx.stroke(); ctx.shadowBlur=0;
            });
        }

        // EYELASHES
        if (ch.eyelashes) {
            var el = ch.eyelashes;
            [ch.eyes.left, ch.eyes.right].forEach(function(eye) {
                var p = proj(eye.x, eye.y, eye.z);
                var r = eye.r * p.s * 80;
                var cnt = el.count||5;
                for (var li=0;li<cnt;li++) {
                    var la = -Math.PI*0.8 + (li/(cnt-1))*Math.PI*0.6;
                    var lx1=p.x+Math.cos(la)*r, ly1=p.y+Math.sin(la)*r;
                    var llen=(el.length||0.05)*p.s*600;
                    ctx.beginPath(); ctx.moveTo(lx1,ly1); ctx.lineTo(lx1+Math.cos(la)*llen, ly1+Math.sin(la)*llen);
                    ctx.strokeStyle=el.color; ctx.lineWidth=el.width||1; ctx.stroke();
                }
            });
        }

        // MOUTH
        (function() {
            var m = ch.mouth; if (!m) return;
            var open = previewMouthOpen;

            var wireAlpha = 0.6 + open * 0.4;
            ctx.shadowBlur = 4 + open * 12;
            ctx.shadowColor = ch.lipColor || ch.accentColor || ch.wireColor;
            ctx.lineCap = 'round';

            if (m.slot) {
                // Drive slot mouth — rectangular opening like a floppy drive
                var slotHW = m.hw;
                var railH = 0.018;
                var drop = open * 0.16 * 1.8;
                var lipC = ch.lipColor || ch.accentColor || ch.wireColor;
                var wireC = ch.wireColor;
                // Top rail
                var tl = proj(-slotHW, m.y + railH, m.z);
                var tr = proj(slotHW, m.y + railH, m.z);
                var tl2 = proj(-slotHW, m.y + railH + 0.008, m.z);
                var tr2 = proj(slotHW, m.y + railH + 0.008, m.z);
                // Bottom rail (drops when opening)
                var bl = proj(-slotHW, m.y - railH - drop, m.z);
                var br = proj(slotHW, m.y - railH - drop, m.z);
                var bl2 = proj(-slotHW, m.y - railH - drop - 0.008, m.z);
                var br2 = proj(slotHW, m.y - railH - drop - 0.008, m.z);
                ctx.shadowBlur = 4 + open * 18;
                ctx.shadowColor = lipC;
                // Top rail double line
                ctx.strokeStyle = wireC; ctx.globalAlpha = 0.6 + open * 0.3; ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.moveTo(tl.x,tl.y); ctx.lineTo(tr.x,tr.y); ctx.stroke();
                ctx.lineWidth = 0.8; ctx.globalAlpha = 0.3;
                ctx.beginPath(); ctx.moveTo(tl2.x,tl2.y); ctx.lineTo(tr2.x,tr2.y); ctx.stroke();
                // Bottom rail double line
                ctx.globalAlpha = 0.6 + open * 0.3; ctx.lineWidth = 1.5;
                ctx.beginPath(); ctx.moveTo(bl.x,bl.y); ctx.lineTo(br.x,br.y); ctx.stroke();
                ctx.lineWidth = 0.8; ctx.globalAlpha = 0.3;
                ctx.beginPath(); ctx.moveTo(bl2.x,bl2.y); ctx.lineTo(br2.x,br2.y); ctx.stroke();
                // Side rails
                ctx.strokeStyle = wireC; ctx.globalAlpha = 0.30; ctx.lineWidth = 0.8;
                ctx.beginPath(); ctx.moveTo(tl.x,tl.y); ctx.lineTo(bl.x,bl.y); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(tr.x,tr.y); ctx.lineTo(br.x,br.y); ctx.stroke();
                // Internal mechanism when open
                if (open > 0.12) {
                    var mechAlpha = Math.min(0.55, (open-0.12) * 4);
                    var mechZ = m.z - 0.04;
                    var railY1 = m.y + railH * 0.3;
                    var railY2 = m.y - railH - drop * 0.4;
                    // Guide rails
                    ctx.strokeStyle = wireC; ctx.globalAlpha = mechAlpha * 0.5; ctx.lineWidth = 0.6;
                    var gl1l=proj(-slotHW*0.9,railY1,mechZ), gl1r=proj(slotHW*0.9,railY1,mechZ);
                    var gl2l=proj(-slotHW*0.9,railY2,mechZ), gl2r=proj(slotHW*0.9,railY2,mechZ);
                    ctx.beginPath(); ctx.moveTo(gl1l.x,gl1l.y); ctx.lineTo(gl1r.x,gl1r.y); ctx.stroke();
                    ctx.beginPath(); ctx.moveTo(gl2l.x,gl2l.y); ctx.lineTo(gl2r.x,gl2r.y); ctx.stroke();
                    // Read head carriage sliding back and forth
                    var headT = performance.now() * 0.002;
                    var headX = Math.sin(headT) * slotHW * 0.5;
                    var headY2 = (railY1 + railY2) * 0.5;
                    var headW = 0.06;
                    ctx.strokeStyle = lipC; ctx.globalAlpha = mechAlpha; ctx.lineWidth = 1.2;
                    ctx.shadowColor = lipC; ctx.shadowBlur = 6 + open * 12;
                    var hl=proj(headX-headW,headY2,mechZ), hr=proj(headX+headW,headY2,mechZ);
                    ctx.beginPath(); ctx.moveTo(hl.x,hl.y); ctx.lineTo(hr.x,hr.y); ctx.stroke();
                    // Vertical arm
                    ctx.lineWidth = 0.6; ctx.globalAlpha = mechAlpha * 0.6;
                    var hcP=proj(headX,railY1,mechZ), hbP=proj(headX,railY2,mechZ);
                    ctx.beginPath(); ctx.moveTo(hcP.x,hcP.y); ctx.lineTo(hbP.x,hbP.y); ctx.stroke();
                }
            } else if (m.pucker) {
                // Pucker: small circle when closed, oval when open
                var puckerR = 0.03;
                var maxW = m.hw * 1.2, maxH = 0.12;
                var openCurve = open * open;
                var mW = puckerR + (maxW - puckerR) * openCurve;
                var mH = puckerR + (maxH - puckerR) * openCurve;
                var segs = m.segs || 12;
                // Outer lip
                ctx.beginPath();
                for (var pi = 0; pi <= segs; pi++) {
                    var pa = (pi / segs) * Math.PI * 2;
                    var pp = proj(mW * Math.cos(pa), m.y + mH * Math.sin(pa), m.z);
                    pi === 0 ? ctx.moveTo(pp.x, pp.y) : ctx.lineTo(pp.x, pp.y);
                }
                ctx.closePath();
                ctx.strokeStyle = ch.lipColor || ch.accentColor || ch.wireColor;
                ctx.lineWidth = 1.8 + (1 - openCurve) * 1.2;
                ctx.globalAlpha = wireAlpha;
                ctx.stroke();
                // Inner lip when open
                if (openCurve > 0.03) {
                    ctx.beginPath();
                    for (var pi2 = 0; pi2 <= segs; pi2++) {
                        var pa2 = (pi2 / segs) * Math.PI * 2;
                        var pp2 = proj(mW * 0.7 * Math.cos(pa2), m.y + mH * 0.7 * Math.sin(pa2), m.z);
                        pi2 === 0 ? ctx.moveTo(pp2.x, pp2.y) : ctx.lineTo(pp2.x, pp2.y);
                    }
                    ctx.closePath();
                    ctx.globalAlpha = wireAlpha * 0.4;
                    ctx.lineWidth = 1.0;
                    ctx.stroke();
                }
            } else if (m.smiley) {
                // Smiley: gentle curved smile, opens when singing
                var upper = [], lower = [];
                for (var si = 0; si <= m.segs; si++) {
                    var st = (si / m.segs) * 2 - 1;
                    var curv = 1 - st * st;
                    var sx = st * m.hw;
                    var yBase = m.y - curv * 0.025;
                    upper.push(proj(sx, yBase + open * 0.09 * curv * 0.5, m.z));
                    lower.push(proj(sx, yBase - open * 0.09 * curv * 2.5 - (open > 0.1 ? 0.015 : 0), m.z));
                }
                ctx.strokeStyle = ch.wireColor;
                ctx.lineWidth = 1.3 + open * 0.8;
                ctx.globalAlpha = 0.5 + open * 0.4;
                ctx.beginPath();
                upper.forEach(function(p, i) { i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); });
                ctx.stroke();
                if (open > 0.1) {
                    ctx.globalAlpha = 0.3 + open * 0.35;
                    ctx.lineWidth = 1.0 + open * 0.5;
                    ctx.beginPath();
                    lower.forEach(function(p, i) { i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); });
                    ctx.stroke();
                }
            } else {
                // Normal mouth: upper lip + lower lip, gap opens with mouthOpen
                var upper2 = [], lower2 = [];
                for (var ni = 0; ni <= m.segs; ni++) {
                    var nt = (ni / m.segs) * 2 - 1;
                    var ncurv = 1 - nt * nt;
                    var nx = nt * m.hw;
                    upper2.push(proj(nx, m.y + open * 0.09 * ncurv + 0.008 * ncurv, m.z));
                    lower2.push(proj(nx, m.y - open * 0.09 * ncurv - 0.008 * ncurv, m.z));
                }
                ctx.strokeStyle = ch.lipColor || ch.accentColor || ch.wireColor;
                ctx.lineWidth = 1.5 + open;
                ctx.globalAlpha = wireAlpha;
                ctx.beginPath();
                upper2.forEach(function(p, i) { i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); });
                ctx.stroke();
                ctx.beginPath();
                lower2.forEach(function(p, i) { i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y); });
                ctx.stroke();
            }

            // TEETH — independent of mouth style, only visible when mouth is open
            if (open > 0.15) {
                var tAlpha = Math.min(0.95, (open - 0.15) * 3);
                if (m.teeth) {
                    var teethN = Math.max(3, Math.floor((m.segs || 8) * 0.7));
                    var tRGB = m.teethColor || '255,255,255';
                    ctx.strokeStyle = 'rgba(' + tRGB + ',' + tAlpha + ')';
                    ctx.shadowColor = 'rgba(' + tRGB + ',0.8)';
                    ctx.shadowBlur = 4 + open * 8;
                    ctx.lineWidth = 1.0;
                    for (var ti = 1; ti < teethN; ti++) {
                        var tt = (ti / teethN) * 2 - 1;
                        var tcurv = 1 - tt * tt;
                        var tx = tt * m.hw * 0.88;
                        var topT = proj(tx, m.y + open * 0.09 * tcurv * 0.75, m.z);
                        var botT = proj(tx, m.y - open * 0.09 * tcurv * 0.75, m.z);
                        ctx.beginPath();
                        ctx.moveTo(topT.x, topT.y);
                        ctx.lineTo(botT.x, botT.y);
                        ctx.stroke();
                    }
                }
                if (m.bucktooth) {
                    var btRGB = m.bucktoothColor || '255,255,255';
                    var btHang = open * 0.09 * 0.65 + 0.012;
                    var btWidth = m.hw * 0.18;
                    var btGap = m.hw * 0.04;
                    ctx.strokeStyle = 'rgba(' + btRGB + ',' + tAlpha + ')';
                    ctx.shadowColor = 'rgba(' + btRGB + ',0.8)';
                    ctx.shadowBlur = 4 + open * 6;
                    ctx.lineWidth = 1.2;
                    // Left tooth
                    var lt1 = proj(-btGap - btWidth, m.y + 0.005, m.z);
                    var lt2 = proj(-btGap,           m.y + 0.005, m.z);
                    var lt3 = proj(-btGap,           m.y - btHang, m.z);
                    var lt4 = proj(-btGap - btWidth, m.y - btHang, m.z);
                    ctx.beginPath(); ctx.moveTo(lt1.x,lt1.y); ctx.lineTo(lt2.x,lt2.y);
                    ctx.lineTo(lt3.x,lt3.y); ctx.lineTo(lt4.x,lt4.y); ctx.closePath();
                    ctx.stroke(); ctx.fillStyle='rgba('+btRGB+','+(tAlpha*0.3)+')'; ctx.fill();
                    // Right tooth
                    var rt1 = proj(btGap,           m.y + 0.005, m.z);
                    var rt2 = proj(btGap + btWidth, m.y + 0.005, m.z);
                    var rt3 = proj(btGap + btWidth, m.y - btHang, m.z);
                    var rt4 = proj(btGap,           m.y - btHang, m.z);
                    ctx.beginPath(); ctx.moveTo(rt1.x,rt1.y); ctx.lineTo(rt2.x,rt2.y);
                    ctx.lineTo(rt3.x,rt3.y); ctx.lineTo(rt4.x,rt4.y); ctx.closePath();
                    ctx.stroke(); ctx.fillStyle='rgba('+btRGB+','+(tAlpha*0.3)+')'; ctx.fill();
                }
            }

            ctx.shadowBlur = 0;
            ctx.globalAlpha = 1;
        })();

        // HAIR
        if (ch.hair) {
            var ht = performance.now() * 0.001;
            var hairProfile = ch.profile;
            ch.hair.forEach(function(strand) {
                // Clamp root to head surface
                var cRoot = clampOutsideHead(hairProfile, strand.rx||0, strand.ry||0, strand.rz||0);
                var rootPt = proj(cRoot.x, cRoot.y, cRoot.z);
                var dx=0, dy=0.8, dz=0;  // default: upward
                if (strand.dir) { dx=strand.dir.dx||0; dy=strand.dir.dy||0; dz=strand.dir.dz||0; }
                else { dx=(cRoot.x>=0?1:-1)*0.15; dy=-1.0; dz=0; }  // legacy: hang down
                // Normalize direction
                var dLen = Math.sqrt(dx*dx+dy*dy+dz*dz)||1;
                var ndx=dx/dLen, ndy=dy/dLen, ndz=dz/dLen;
                var segs=8, sLen=(strand.len||0.5);
                ctx.beginPath(); ctx.moveTo(rootPt.x, rootPt.y);
                for (var hs=1; hs<=segs; hs++) {
                    var frac = hs/segs;
                    var travel = sLen * frac;
                    var gravityPull = strand.dir ? frac*frac*0.15 : 0;
                    var bx = cRoot.x + ndx*travel;
                    var by = cRoot.y + ndy*travel - gravityPull;
                    var bz = cRoot.z + ndz*travel;
                    // Sway animation
                    var sw = Math.sin(ht*2+(strand.freq||0)*20+hs*0.5)*0.02*frac;
                    bx += sw;
                    // Clamp early segments to head surface
                    if (frac < 0.35 && hairProfile) {
                        var cl = clampOutsideHead(hairProfile, bx, by, bz);
                        bx=cl.x; by=cl.y; bz=cl.z;
                    }
                    var hp = proj(bx, by, bz);
                    ctx.lineTo(hp.x, hp.y);
                }
                ctx.strokeStyle = strand.color||ch.wireColor;
                ctx.lineWidth = strand.width||1.5;
                ctx.globalAlpha = 0.7; ctx.stroke();
            });
            ctx.globalAlpha = 1;
        }

        // HAT
        if (ch.hat) {
            var hat = ch.hat, topY = prof[prof.length-1][1];
            if (hat.type === 'cowboy') {
                var crH=0.25, crW=0.28;
                var pts=[proj(-crW,topY,0),proj(-crW*0.85,topY+crH,0),proj(0,topY+crH*0.90,0),proj(crW*0.85,topY+crH,0),proj(crW,topY,0)];
                ctx.beginPath(); pts.forEach(function(p,i){i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y);}); ctx.closePath();
                ctx.strokeStyle=hat.color; ctx.lineWidth=2; ctx.stroke();
                ctx.fillStyle=hat.color; ctx.globalAlpha=0.3; ctx.fill(); ctx.globalAlpha=1;
                var bL=proj(-0.55,topY-0.04,0.15),bR=proj(0.55,topY-0.04,0.15),bC=proj(0,topY+0.02,0.20);
                ctx.beginPath(); ctx.moveTo(bL.x,bL.y); ctx.quadraticCurveTo(bC.x,bC.y,bR.x,bR.y);
                ctx.strokeStyle=hat.color; ctx.lineWidth=3; ctx.stroke();
                if (hat.bandColor) {
                    var bnL=proj(-crW,topY+0.02,0.01),bnR=proj(crW,topY+0.02,0.01);
                    ctx.beginPath();ctx.moveTo(bnL.x,bnL.y);ctx.lineTo(bnR.x,bnR.y);
                    ctx.strokeStyle=hat.bandColor;ctx.lineWidth=3;ctx.stroke();
                }
            } else if (hat.type === 'baseballcap') {
                var crH2=0.20, crW2=0.34;
                ctx.beginPath();
                for(var ci=0;ci<=12;ci++){var ct=(ci/12)*Math.PI;var cp=proj(Math.cos(ct)*crW2,topY+Math.sin(ct)*crH2,0);ci===0?ctx.moveTo(cp.x,cp.y):ctx.lineTo(cp.x,cp.y);}
                ctx.strokeStyle=hat.color;ctx.lineWidth=2;ctx.stroke();
                ctx.fillStyle=hat.color;ctx.globalAlpha=0.25;ctx.fill();ctx.globalAlpha=1;
                var bTip=proj(0,topY-0.02,0.55),bL2=proj(-0.20,topY,0.30),bR2=proj(0.20,topY,0.30);
                ctx.beginPath();ctx.moveTo(bL2.x,bL2.y);ctx.quadraticCurveTo(bTip.x,bTip.y,bR2.x,bR2.y);
                ctx.strokeStyle=hat.color;ctx.lineWidth=3;ctx.stroke();
                if (hat.text) {
                    var tc=proj(0,topY+crH2*0.5,0.05); var dpr=window.devicePixelRatio||1;
                    ctx.fillStyle='#fff';ctx.font='bold '+(9*dpr)+'px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
                    ctx.globalAlpha=0.8;ctx.fillText(hat.text,tc.x,tc.y);ctx.globalAlpha=1;
                }
            } else if (hat.type === 'afro') {
                // Hemisphere dome from hairline upward (matches visualizer drawAfro)
                var aH=hat.height||0.62, aRx=hat.radiusX||0.68, aRz=hat.radiusZ||0.56, aRings=hat.rings||8;
                var afroBase = 0.16; // hairline level
                for(var ri=0;ri<=aRings;ri++){
                    var frac=ri/aRings;
                    var angle=frac*Math.PI*0.5; // 0..90 degrees hemisphere
                    var arY=afroBase+aH*Math.sin(angle);
                    var taper=Math.max(0.08, Math.cos(angle)); // 1 at base, small at top
                    ctx.beginPath();
                    for(var aj=0;aj<=16;aj++){var aa=(aj/16)*Math.PI*2;var ap=proj(Math.cos(aa)*aRx*taper,arY,Math.sin(aa)*aRz*taper);aj===0?ctx.moveTo(ap.x,ap.y):ctx.lineTo(ap.x,ap.y);}
                    ctx.strokeStyle=hat.color;ctx.lineWidth=1.2;ctx.globalAlpha=0.4;ctx.stroke();
                }
                ctx.globalAlpha=1;
            }
        }

        // FACIAL HAIR
        if (ch.facialHair && ch.facialHair.type === 'moustache') {
            var fh = ch.facialHair;
            var baseY2 = ch.nose ? ch.nose.base[1][1] : -0.34;
            var baseZ2 = ch.nose ? ch.nose.base[1][2] : 0.54;
            var fc=proj(0,baseY2,baseZ2), fl=proj(-fh.spread,baseY2-fh.droop,baseZ2-0.04);
            var flt=proj(-fh.spread+0.02,baseY2-fh.droop+fh.curl,baseZ2-0.03);
            ctx.beginPath();ctx.moveTo(fc.x,fc.y);ctx.quadraticCurveTo(fl.x,fl.y,flt.x,flt.y);
            ctx.strokeStyle=fh.color;ctx.lineWidth=fh.width||1.8;ctx.stroke();
            var fr=proj(fh.spread,baseY2-fh.droop,baseZ2-0.04);
            var frt=proj(fh.spread-0.02,baseY2-fh.droop+fh.curl,baseZ2-0.03);
            ctx.beginPath();ctx.moveTo(fc.x,fc.y);ctx.quadraticCurveTo(fr.x,fr.y,frt.x,frt.y);ctx.stroke();
        }

        // NECK (bridge head to body, especially important for boxy heads)
        (function() {
            var neckW = ch.headShape === 'box' ? ch.boxDims.w * 0.45 : 0.12;
            var neckTop, neckBot;
            if (ch.headShape === 'box') {
                neckTop = proj(0, -(ch.boxDims.h || 0.55), 0);
                neckBot = proj(0, -(ch.boxDims.h || 0.55) - 0.12, 0);
            } else {
                var chinY = ch.profile ? ch.profile[0][1] : -0.76;
                neckTop = proj(0, chinY, 0);
                neckBot = proj(0, chinY - 0.10, 0);
            }
            var nL = proj(-neckW, neckTop.y/headR, 0);
            var nR = proj(neckW, neckTop.y/headR, 0);
            // Use skin/torso color for neck
            var neckColor = (ch.body && ch.body.zones && ch.body.zones.skin) || ch.wireColor;
            ctx.strokeStyle = neckColor; ctx.lineWidth = 2;
            ctx.globalAlpha = 0.6;
            ctx.beginPath(); ctx.moveTo(neckTop.x - neckW*headR*0.8, neckTop.y);
            ctx.lineTo(neckTop.x - neckW*headR*0.6, neckBot.y);
            ctx.moveTo(neckTop.x + neckW*headR*0.8, neckTop.y);
            ctx.lineTo(neckTop.x + neckW*headR*0.6, neckBot.y);
            ctx.stroke(); ctx.globalAlpha = 1;
        })();

        // BODY
        (function() {
            var body = ch.body; if (!body||!body.skeleton||!body.bones) return;
            var skel=body.skeleton, bScale=headR*0.90, bTop=cy+headR*0.72*pulse;
            var joints = {};
            for (var jn in skel) {
                if (!skel.hasOwnProperty(jn)) continue;
                var j=skel[jn], jdx=j.x, jdy=j.y;
                if (previewDancing) {
                    var sw=Math.sin(danceTime*4)*0.03, bn=Math.abs(Math.sin(danceTime*8))*0.02;
                    if (jn==='handL'||jn==='elbowL') jdx+=sw*2;
                    if (jn==='handR'||jn==='elbowR') jdx-=sw*2;
                    if (jn==='footL') jdx+=sw;
                    if (jn==='footR') jdx-=sw;
                    if (jn==='kneeL'||jn==='kneeR') jdy+=bn;
                    if (jn==='hip'||jn==='hipL'||jn==='hipR') jdy+=bn*0.5;
                }
                joints[jn] = { x: cx+jdx*bScale, y: bTop+jdy*bScale };
            }
            var BONE_ZONES = ['upper','upper','upper','upper','upper','skin','skin','torso','lower','lower','lower','lower','lower','lower'];
            body.bones.forEach(function(b,bi) {
                var j1=joints[b[0]], j2=joints[b[1]]; if(!j1||!j2) return;
                var zone = BONE_ZONES[bi]||'upper';
                var zc;
                if (body.rainbow) {
                    var ZONE_HUE_OFFSET = { upper: 0, skin: 72, torso: 144, lower: 216, feet: 288 };
                    var baseHue = (danceTime * 60) % 360;
                    var hue = (baseHue + (ZONE_HUE_OFFSET[zone]||0)) % 360;
                    zc = hslToHex(hue, 90, 55);
                } else {
                    zc = (body.clothing&&body.clothing[zone]) ? body.clothing[zone].color : ch.wireColor;
                }
                ctx.beginPath();ctx.moveTo(j1.x,j1.y);ctx.lineTo(j2.x,j2.y);
                ctx.strokeStyle=zc;ctx.lineWidth=body.glowWidth||6;ctx.globalAlpha=0.15;ctx.stroke();
                ctx.beginPath();ctx.moveTo(j1.x,j1.y);ctx.lineTo(j2.x,j2.y);
                ctx.strokeStyle=zc;ctx.lineWidth=body.lineWidth||1.8;ctx.globalAlpha=0.85;ctx.stroke();
            });
            ctx.globalAlpha=1;
            for(var jk in joints){if(!joints.hasOwnProperty(jk))continue;
                ctx.beginPath();ctx.arc(joints[jk].x,joints[jk].y,2,0,Math.PI*2);
                ctx.fillStyle=body.rainbow?hslToHex((danceTime*60)%360,90,65):(body.color||ch.wireColor);ctx.fill();}
            // Skirt
            if (body.skirt) {
                var sk=body.skirt, hipC=joints.hip;
                if (hipC){
                    ctx.beginPath();
                    var hPts=sk.hemPoints||5, hY=bTop+(sk.hemY||0.46)*bScale, hSp=(sk.hemSpread||0.18)*bScale;
                    ctx.moveTo(joints.hipL?joints.hipL.x:hipC.x-10,hipC.y);
                    for(var hi=0;hi<=hPts;hi++){var ht2=hi/hPts;ctx.lineTo(hipC.x+(ht2*2-1)*hSp, hY+Math.sin(danceTime*3+ht2*4)*(sk.sway||0.03)*bScale);}
                    ctx.lineTo(joints.hipR?joints.hipR.x:hipC.x+10,hipC.y);ctx.closePath();
                    var skZone=sk.zone||'lower';
                    var skC=body.rainbow?hslToHex(((danceTime*60)%360+(216))%360,90,55):((body.clothing&&body.clothing[skZone])?body.clothing[skZone].color:ch.wireColor);
                    ctx.fillStyle=skC;ctx.globalAlpha=0.25;ctx.fill();
                    ctx.strokeStyle=skC;ctx.lineWidth=1.5;ctx.globalAlpha=0.6;ctx.stroke();ctx.globalAlpha=1;
                }
            }
        })();

    }

    // ==============================================================
    //  CONTROL PANEL
    // ==============================================================
    var controlsDef = [
        { id:'face', title:'&#128100; Face Shape & Colors', fields:[
            {key:'faceShape',label:'Face Shape',type:'select',options:FACE_SHAPES},
            {key:'wireColor',label:'Wire Color',type:'color'},
            {key:'accentColor',label:'Accent Color',type:'color'},
            {key:'ringN',label:'Ring Count',type:'range',min:8,max:24,step:2}
        ]},
        { id:'eyes', title:'&#128065; Eyes', fields:[
            {key:'eyeShape',label:'Eye Shape',type:'select',options:EYE_SHAPES},
            {key:'eyeSize',label:'Eye Size',type:'range',min:0.03,max:0.14,step:0.005},
            {key:'eyeSpacing',label:'Eye Spacing',type:'range',min:0.10,max:0.28,step:0.01},
            {key:'eyeHeight',label:'Eye Height',type:'range',min:-0.15,max:0.10,step:0.01},
            {key:'eyeColor',label:'Eye Color (null=wire)',type:'color',nullable:true},
            {key:'eyeOutlineColor',label:'Eye Outline',type:'color',nullable:true},
            {key:'hasMascara',label:'Mascara',type:'toggle'},
            {key:'hasEyelashes',label:'Eyelashes',type:'toggle'},
            {key:'eyelashLength',label:'Eyelash Length',type:'range',min:0.01,max:0.14,step:0.005,showWhen:'hasEyelashes'},
            {key:'eyelashColor',label:'Eyelash Color',type:'color',showWhen:'hasEyelashes'}
        ]},
        { id:'eyebrows', title:'&#129320; Eyebrows', fields:[
            {key:'hasEyebrows',label:'Eyebrows',type:'toggle'},
            {key:'eyebrowColor',label:'Brow Color',type:'color',showWhen:'hasEyebrows'},
            {key:'eyebrowWidth',label:'Brow Width',type:'range',min:1.0,max:4.0,step:0.2,showWhen:'hasEyebrows'},
            {key:'eyebrowThickness',label:'Brow Thickness',type:'range',min:0.008,max:0.035,step:0.002,showWhen:'hasEyebrows'}
        ]},
        { id:'mouth', title:'&#128068; Mouth', fields:[
            {key:'lipColor',label:'Lip Color',type:'color'},
            {key:'mouthType',label:'Mouth Style',type:'select',options:MOUTH_TYPES},
            {key:'mouthWidth',label:'Mouth Width',type:'range',min:0.10,max:0.40,step:0.01},
            {key:'mouthY',label:'Mouth Position',type:'range',min:-0.60,max:-0.40,step:0.01},
            {key:'teethType',label:'Teeth',type:'select',options:TEETH_TYPES},
            {key:'teethColor',label:'Teeth Color',type:'color'}
        ]},
        { id:'nose', title:'&#128067; Nose', fields:[
            {key:'hasNose',label:'Has Nose',type:'toggle'}
        ]},
        { id:'hair', title:'&#128135; Hair', fields:[
            {key:'hairStyle',label:'Hair Style',type:'select',options:Object.keys(HAIR_PRESETS)},
            {key:'hairColor',label:'Hair Color',type:'color'}
        ]},
        { id:'hat', title:'&#127913; Hat', fields:[
            {key:'hatType',label:'Hat Type',type:'select',options:HAT_TYPES},
            {key:'hatColor',label:'Hat Color',type:'color'},
            {key:'hatBandColor',label:'Band Color',type:'color'},
            {key:'hatText',label:'Cap Text',type:'text'}
        ]},
        { id:'facialhair', title:'&#129490; Facial Hair', fields:[
            {key:'facialHairType',label:'Type',type:'select',options:FACIAL_HAIR_TYPES},
            {key:'facialHairColor',label:'Color',type:'color'}
        ]},
        { id:'clothing', title:'&#128085; Clothing', fields:[
            {key:'clothingUpper',label:'Upper (Shoulders/Arms)',type:'color'},
            {key:'clothingSkin',label:'Skin (Hands)',type:'color'},
            {key:'clothingTorso',label:'Torso',type:'color'},
            {key:'clothingLower',label:'Lower (Legs)',type:'color'},
            {key:'clothingFeet',label:'Feet',type:'color'},
            {key:'hasSkirt',label:'Skirt',type:'toggle'},
            {key:'bodyRainbow',label:'Rainbow Mode',type:'toggle'}
        ]}
    ];

    function buildControls() {
        var root = document.getElementById('rsd-controls');
        if (!root) return;
        root.innerHTML = '';
        controlsDef.forEach(function(section) {
            var sec = document.createElement('div');
            sec.className = 'rsd-section'; sec.id = 'rsd-sec-'+section.id;
            sec.classList.add('collapsed');
            var hdr = document.createElement('div');
            hdr.className = 'rsd-section-header';
            hdr.innerHTML = section.title + ' <span class="rsd-chevron">&#9660;</span>';
            hdr.addEventListener('click', function(){
                var wasCollapsed = sec.classList.contains('collapsed');
                root.querySelectorAll('.rsd-section').forEach(function(s){ s.classList.add('collapsed'); });
                if (wasCollapsed) sec.classList.remove('collapsed');
            });
            sec.appendChild(hdr);
            var bd = document.createElement('div');
            bd.className = 'rsd-section-body';
            section.fields.forEach(function(f) {
                var field = document.createElement('div');
                field.className = 'rsd-field'; field.dataset.key = f.key;
                if (f.showWhen) field.dataset.showWhen = f.showWhen;
                var lbl = document.createElement('label');
                lbl.textContent = f.label; field.appendChild(lbl);
                var input;
                if (f.type === 'select') {
                    input = document.createElement('select');
                    f.options.forEach(function(opt){var o=document.createElement('option');o.value=opt;o.textContent=opt.replace(/_/g,' ');input.appendChild(o);});
                    input.value = charState[f.key];
                    input.addEventListener('change', function(){
                        charState[f.key]=input.value;
                        if(f.key==='faceShape') {
                        if(input.value==='boxy') { charState.headShape='box'; charState.profile=deepClone(DEFAULT_PROFILES.round); }
                        else { charState.headShape=null; charState.profile=deepClone(DEFAULT_PROFILES[input.value]||DEFAULT_PROFILES.round); }
                    }
                        updateVis();
                    });
                } else if (f.type === 'color') {
                    var wrap = document.createElement('div');
                    wrap.style.cssText = 'display:flex;gap:0.4rem;align-items:center';
                    input = document.createElement('input'); input.type='color';
                    input.value = charState[f.key] || '#33FF33';
                    input.addEventListener('input', function(){
                        charState[f.key]=input.value;
                        if(f.key==='wireColor') charState.wireRGB=hexToRgb(input.value);
                        if(f.key==='accentColor') charState.accentRGB=hexToRgb(input.value);
                    });
                    wrap.appendChild(input);
                    if (f.nullable) {
                        var cb = document.createElement('input'); cb.type='checkbox';
                        cb.checked = !!charState[f.key]; cb.title='Enable custom color';
                        cb.addEventListener('change', function(){ charState[f.key]=cb.checked?input.value:null; input.disabled=!cb.checked; });
                        input.disabled = !charState[f.key];
                        wrap.appendChild(cb);
                        var cbLbl=document.createElement('span');cbLbl.textContent='on';cbLbl.style.cssText='font-size:0.7rem;color:#666';wrap.appendChild(cbLbl);
                    }
                    field.appendChild(wrap); bd.appendChild(field); return;
                } else if (f.type === 'range') {
                    var row = document.createElement('div'); row.className='rsd-range-row';
                    input = document.createElement('input'); input.type='range';
                    input.min=f.min; input.max=f.max; input.step=f.step; input.value=charState[f.key];
                    var prec = f.step<0.1?3:f.step<1?2:0;
                    var val = document.createElement('span'); val.className='rsd-range-val';
                    val.textContent = Number(charState[f.key]).toFixed(prec);
                    input.addEventListener('input', function(){ charState[f.key]=parseFloat(input.value); val.textContent=Number(input.value).toFixed(prec); });
                    row.appendChild(input); row.appendChild(val);
                    field.appendChild(row); bd.appendChild(field); return;
                } else if (f.type === 'toggle') {
                    input = document.createElement('input'); input.type='checkbox';
                    input.checked = !!charState[f.key];
                    input.addEventListener('change', function(){ charState[f.key]=input.checked; updateVis(); });
                } else if (f.type === 'text') {
                    input = document.createElement('input'); input.type='text';
                    input.value = charState[f.key]||''; input.maxLength=20;
                    input.addEventListener('input', function(){ charState[f.key]=input.value; });
                }
                if (input) field.appendChild(input);
                bd.appendChild(field);
            });
            sec.appendChild(bd); root.appendChild(sec);
        });
        updateVis();
    }

    function updateVis() {
        document.querySelectorAll('.rsd-field[data-show-when]').forEach(function(f){
            f.style.display = charState[f.dataset.showWhen] ? '' : 'none';
        });
    }



    // Sync all DOM controls from charState
    function syncUI() {
        var nameInput = document.getElementById('rsd-char-name');
        if (nameInput) nameInput.value = charState.name||'';
        document.querySelectorAll('.rsd-field').forEach(function(field){
            var key=field.dataset.key; if(!key) return;
            var val=charState[key];
            var input=field.querySelector('select, input');
            if(!input) return;
            if(input.type==='checkbox'){input.checked=!!val;}
            else if(input.type==='color'){
                input.value=val||'#33FF33';
                var cb=field.querySelector('input[type="checkbox"]');
                if(cb){cb.checked=!!val;input.disabled=!val;}
            } else if(input.type==='range'){
                input.value=val;
                var vs=field.querySelector('.rsd-range-val');
                if(vs){var st=parseFloat(input.step)||1;vs.textContent=Number(val).toFixed(st<0.1?3:st<1?2:0);}
            } else if(input.tagName==='SELECT'){input.value=val;}
            else{input.value=val||'';}
        });
        updateVis();
    }

    // -- Randomize -------------------------------------------------
    function randomize() {
        var c = charState;
        c.faceShape=FACE_SHAPES[Math.floor(Math.random()*FACE_SHAPES.length)];
        if(c.faceShape==='boxy'){c.headShape='box';c.profile=deepClone(DEFAULT_PROFILES.round);}
        else{c.headShape=null;c.profile=deepClone(DEFAULT_PROFILES[c.faceShape]);}
        c.wireColor=hslToHex(Math.random()*360,70+Math.random()*30,50+Math.random()*30); c.wireRGB=hexToRgb(c.wireColor);
        c.accentColor=hslToHex(Math.random()*360,60+Math.random()*40,50+Math.random()*30); c.accentRGB=hexToRgb(c.accentColor);
        c.eyeShape=EYE_SHAPES[Math.floor(Math.random()*EYE_SHAPES.length)];
        c.eyeSize=0.05+Math.random()*0.06; c.eyeSpacing=0.12+Math.random()*0.10; c.eyeHeight=-0.10+Math.random()*0.12;
        c.eyeColor=Math.random()>0.4?hslToHex(Math.random()*360,60,55):null;
        c.eyeOutlineColor=Math.random()>0.6?hslToHex(Math.random()*360,50,50):null;
        c.hasEyebrows=Math.random()>0.4; c.eyebrowColor=hslToHex(Math.random()*360,40,40);
        c.eyebrowWidth=1.5+Math.random()*2; c.eyebrowThickness=0.012+Math.random()*0.018;
        c.lipColor=hslToHex(Math.random()*360,60+Math.random()*40,45+Math.random()*30);
        c.mouthType=MOUTH_TYPES[Math.floor(Math.random()*MOUTH_TYPES.length)];
        c.teethType=TEETH_TYPES[Math.floor(Math.random()*TEETH_TYPES.length)];
        c.mouthWidth=0.15+Math.random()*0.20; c.mouthY=-0.56+Math.random()*0.10;
        c.hasNose=Math.random()>0.2;
        var hk=Object.keys(HAIR_PRESETS); c.hairStyle=hk[Math.floor(Math.random()*hk.length)];
        c.hairColor=hslToHex(Math.random()*360,70,55);
        c.hatType=Math.random()>0.7?HAT_TYPES[1+Math.floor(Math.random()*(HAT_TYPES.length-1))]:'none';
        c.hatColor=hslToHex(Math.random()*360,50,40); c.hatBandColor=hslToHex(Math.random()*360,40,30);
        c.facialHairType=Math.random()>0.7?'moustache':'none'; c.facialHairColor=hslToHex(Math.random()*60,50,40);
        c.hasMascara=Math.random()>0.7; c.hasEyelashes=Math.random()>0.6; c.eyelashLength=0.015+Math.random()*0.10; c.eyelashColor=hslToHex(Math.random()*360,70,65);
        c.clothingUpper=hslToHex(Math.random()*360,60,50); c.clothingSkin=hslToHex(20+Math.random()*30,50+Math.random()*30,60+Math.random()*25);
        c.clothingTorso=hslToHex(Math.random()*360,60,50); c.clothingLower=hslToHex(Math.random()*360,40,40);
        c.clothingFeet=hslToHex(Math.random()*360,30,50); c.hasSkirt=Math.random()>0.7; c.bodyRainbow=Math.random()>0.85;
        syncUI();
    }

    // ==============================================================
    //  PREVIEW IN VISUALIZER
    // ==============================================================
    function assignToCurrentTrack() {
        var radio = window.sbbsRadio;
        if (!radio || !radio.currentTrackFile) {
            alert('No track is currently loaded. Play a track first.');
            return;
        }
        var def = buildCharDef();
        def.name = charState.name || 'Custom Character';
        var charJson = JSON.stringify(def);
        var dirCode = radio.dirCode;
        var csrfToken = (window.sbbsConfig && window.sbbsConfig.csrfToken)
            ? String(window.sbbsConfig.csrfToken) : '';

        var body = new URLSearchParams();
        body.set('file', radio.currentTrackFile);
        body.set('character', charJson);

        var btn = document.getElementById('rsd-btn-assign');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving\u2026'; }

        fetch('./api/files.ssjs?call=update-track-meta&dir=' + encodeURIComponent(dirCode), {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'x-csrf-token': csrfToken
            },
            body: body
        })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data && data.error) throw new Error(data.error);
            if (btn) { btn.textContent = '\u2605 Assigned!'; }
            document.dispatchEvent(new CustomEvent('rsd:character-assigned', { detail: { file: radio.currentTrackFile, character: charJson } }));
            setTimeout(function() {
                if (btn) { btn.disabled = false; btn.textContent = 'Assign to Current Track'; }
            }, 2000);
        })
        .catch(function(err) {
            alert('Could not assign character: ' + (err.message || err));
            if (btn) { btn.disabled = false; btn.textContent = 'Assign to Current Track'; }
        });
    }

    function previewInVisualizer() {
        var def = buildCharDef();
        def.name = charState.name || 'Custom Character';
        // Inject into visualizer's CHARACTERS object
        if (window._CHARS) {
            window._CHARS['_rsd_preview'] = def;
        }
        // Open the visualizer
        document.dispatchEvent(new CustomEvent('viz:open'));
        // Give viz a moment to open, then set the character
        setTimeout(function() {
            if (window._setChar) window._setChar('_rsd_preview');
            // Start playing if not already
            var radio = window.sbbsRadio;
            if (radio && !radio.isPlaying) {
                var playBtn = document.getElementById('radio-play');
                if (playBtn) playBtn.click();
            }
        }, 300);
    }

    // ==============================================================
    //  INIT
    // ==============================================================
    function init() {
        buildControls(); initPreview();
        var nameInput = document.getElementById('rsd-char-name');
        if(nameInput) nameInput.addEventListener('input', function(){ charState.name=nameInput.value; });

        document.getElementById('rsd-btn-dance').addEventListener('click', function(){
            previewDancing=!previewDancing; this.classList.toggle('active', previewDancing);
        });
        document.getElementById('rsd-btn-mouth').addEventListener('click', function(){
            previewMouthToggle=!previewMouthToggle; this.classList.toggle('active', previewMouthToggle);
        });
        var btnSpin = document.getElementById('rsd-btn-spin');
        btnSpin.addEventListener('click', function(){
            previewSpinning=!previewSpinning; this.classList.toggle('active', previewSpinning);
        });

        document.getElementById('rsd-btn-randomize').addEventListener('click', randomize);
        var btnPreview = document.getElementById('rsd-btn-preview');
        if (btnPreview) btnPreview.addEventListener('click', previewInVisualizer);
        var btnAssign = document.getElementById('rsd-btn-assign');
        if (btnAssign) btnAssign.addEventListener('click', assignToCurrentTrack);
    }

    function tryInit() {
        var c = document.getElementById('rsd-canvas');
        if (!c || c.getBoundingClientRect().width < 1) { setTimeout(tryInit, 200); return; }
        init();
    }
    /* Expose helpers for embedded use (Record Label tab) */
    window.getRockstarDesignerCharacter = function () {
        if (typeof buildCharDef !== 'function') return null;
        try { return JSON.stringify(buildCharDef()); } catch(e) { return null; }
    };
    window.resizeRockstarDesigner = function () { sizeCanvas(); };

    if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',tryInit);
    else setTimeout(tryInit, 100);
})();

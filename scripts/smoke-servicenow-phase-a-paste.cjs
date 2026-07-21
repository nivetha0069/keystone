const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

global.Class = {
  create() {
    return function ServiceNowClass(...args) {
      if (typeof this.initialize === 'function') this.initialize(...args);
    };
  },
};

global.gs = {
  getProperty(name, fallback) {
    return fallback;
  },
};

global.GlideDigest = function GlideDigest() {
  this.getSHA256Hex = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
};

function load(fileName) {
  const file = path.join(__dirname, '..', 'servicenow', fileName);
  vm.runInThisContext(fs.readFileSync(file, 'utf8'), { filename: file });
}

load('DotwalkersAgentEventDetailService.js');
load('DotwalkersFailureStrategyService.js');
load('DotwalkersAgentSupport.phase-a.js');
load('DotwalkersIrePayloadService.phase-b3.js');
load('DotwalkersPhaseATests.phase-a.js');

const report = JSON.parse(new DotwalkersPhaseATests().run());
assert.equal(report.failed, 0, JSON.stringify(report.results.filter((result) => !result.passed), null, 2));
assert.equal(report.passed, report.total);
console.log(`Phase A paste-ready smoke passed (${report.passed}/${report.total}).`);

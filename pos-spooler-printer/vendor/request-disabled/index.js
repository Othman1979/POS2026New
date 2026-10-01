'use strict';

module.exports = function requestDisabled() {
  throw new Error('Remote image loading is disabled in the POS spooler');
};

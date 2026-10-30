'use strict';

// Use ordinary Win32 paths for filesystem access and comparisons, including UNC shares.
function plain(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/^\\{1,2}\?\\UNC\\/i, '\\\\')
    .replace(/^\\{1,2}\?\\(?=[a-z]:[\\/])/i, '');
}
module.exports = { plain };

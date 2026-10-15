/**
 * Librerías de terceros que `npm run build:vendor` empaqueta en js/vendor/.
 *
 * Cada entrada se fija a una versión exacta en package.json y se convierte en un
 * IIFE clásico `js/vendor/<id>.browser.js` que define el global `ZeroChat<Id>`
 * (convención compartida con js/vendor-loader.js), de modo que funciona en file:// y en Node.
 * `onDemand` marca las que no se cargan al arrancar ni entran en el precache del
 * service worker; se piden con ChatVendorLoader la primera vez que hacen falta.
 */
export const VENDORS = [
  {
    id: 'orama',
    package: '@orama/orama',
    exports: ['create', 'insertMultiple', 'search'],
    onDemand: false,
    license: { file: 'LICENSE.md', name: 'Apache License 2.0', copyright: 'Copyright 2023 OramaSearch Inc' },
    source: 'https://github.com/oramasearch/orama'
  },
  {
    id: 'mammoth',
    package: 'mammoth',
    exports: ['convertToHtml', 'images'],
    onDemand: true,
    license: { file: 'LICENSE', name: 'BSD 2-Clause License', copyright: 'Copyright (c) 2013 Michael Williamson' },
    source: 'https://github.com/mwilliamson/mammoth.js'
  },
  {
    id: 'exceljs',
    package: 'exceljs',
    exports: ['Workbook'],
    onDemand: true,
    license: { file: 'LICENSE', name: 'MIT License', copyright: 'Copyright (c) 2014-2019 Guyon Roche' },
    source: 'https://github.com/exceljs/exceljs'
  },
  {
    id: 'fflate',
    package: 'fflate',
    exports: ['unzipSync', 'strFromU8'],
    onDemand: true,
    license: { file: 'LICENSE', name: 'MIT License', copyright: 'Copyright (c) 2026 Arjun Barrett' },
    source: 'https://github.com/101arrowz/fflate'
  }
];

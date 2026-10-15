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
    onDemand: false
  },
  {
    id: 'mammoth',
    package: 'mammoth',
    exports: ['convertToHtml', 'images'],
    onDemand: true
  },
  {
    id: 'exceljs',
    package: 'exceljs',
    exports: ['Workbook'],
    onDemand: true
  },
  {
    id: 'fflate',
    package: 'fflate',
    exports: ['unzipSync', 'strFromU8'],
    onDemand: true
  }
];

const test = require('node:test');
const assert = require('node:assert/strict');
const FilesPage = require('../../js/files-page.js');

test('FilesPage - el proyecto y la carpeta viajan en la URL, la carpeta relativa al proyecto', () => {
  assert.deepEqual(FilesPage.readPageParams('?project=%2Fhome%2Fyo%2Fapp&path=src%2Futil%2F'), { project: '/home/yo/app', path: 'src/util' });
  assert.deepEqual(FilesPage.readPageParams(''), { project: '', path: '' });
  assert.equal(FilesPage.pageUrl('/home/yo/app', ''), '?project=%2Fhome%2Fyo%2Fapp');
  assert.equal(FilesPage.pageUrl('/home/yo/app', 'src/a b'), '?project=%2Fhome%2Fyo%2Fapp&path=src%2Fa+b');
  assert.deepEqual(FilesPage.readPageParams(FilesPage.pageUrl('/home/yo/app', 'src/a b')), { project: '/home/yo/app', path: 'src/a b' });
});

test('FilesPage - cada fallo de conexión tiene su explicación; un error del servidor muestra su propio mensaje', () => {
  assert.equal(FilesPage.errorKey({ status: 401 }), 'files_error_login');
  assert.equal(FilesPage.errorKey({ rpcError: { code: -32003 } }), 'files_error_project_gone');
  assert.equal(FilesPage.errorKey({ rpcError: { code: -32602, message: 'La carpeta no existe.' } }), null);
  assert.equal(FilesPage.errorKey(new TypeError('Failed to fetch')), 'files_error_unreachable');
});

test('FilesPage - las migas llevan del proyecto a cada carpeta del camino', () => {
  assert.deepEqual(FilesPage.breadcrumbs('/home/yo/app', ''), [{ label: 'app', path: '' }]);
  assert.deepEqual(FilesPage.breadcrumbs('/home/yo/app', 'src/util'), [
    { label: 'app', path: '' },
    { label: 'src', path: 'src' },
    { label: 'util', path: 'src/util' }
  ]);
  assert.equal(FilesPage.childPath('', 'src'), 'src');
  assert.equal(FilesPage.childPath('src', 'util'), 'src/util');
});

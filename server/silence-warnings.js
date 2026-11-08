// node:sqlite masih berlabel "experimental" di Node 22 dan memunculkan peringatan
// di console. Peringatan itu tidak berbahaya, jadi disembunyikan. Peringatan lain tetap tampil.
process.removeAllListeners('warning');
process.on('warning', (w) => {
  if (w.name === 'ExperimentalWarning') return;
  console.warn(`${w.name}: ${w.message}`);
});

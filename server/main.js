// Titik masuk aplikasi (juga dipakai untuk cctv.exe).
//   cctv.exe                      -> jalankan web
//   cctv.exe reset-admin [pass]   -> reset password admin
import './silence-warnings.js';

if (process.argv.includes('reset-admin')) {
  import('./reset-admin.js');
} else {
  import('./index.js');
}

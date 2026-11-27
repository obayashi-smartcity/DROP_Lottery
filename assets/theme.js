// 画面全体の背景色（config.js の BG_COLOR）を、ページを描く前に当てる。
// <head> で config.js の直後に読み込む（ページを描く前に色が決まるので、ベージュが一瞬見えることがない）。
// 形式は「#」＋16進6桁（例: #CCE0C7）。空・形式が違う（#CCE のような3桁、色名、# なしなど）ときは何もしない
// ＝ style.css のベージュ（--page-bg の既定値）のまま。config.js が読めなかったときもベージュ。
// カード・ボタン・入力欄など、ほかの部品の色は変えない（使うのは body の背景の --page-bg だけ）。
(function () {
  const CFG = window.LOTTERY_CONFIG || {};
  const value = CFG.BG_COLOR;
  if (value === undefined || value === null || value === '') return;
  if (typeof value !== 'string' || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
    console.warn(`BG_COLOR の形式が正しくありません（「#」＋16進6桁。例: #CCE0C7）。ベージュで表示します: ${String(value)}`);
    return;
  }
  document.documentElement.style.setProperty('--page-bg', value);
  // ブラウザのアドレスバーなどの色も合わせる
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', value);
})();

export function connectGuideMotion(root: HTMLElement, preference: MediaQueryList) {
  const images = Array.from(root.querySelectorAll<HTMLImageElement>('img[data-gif][data-poster]'));
  const toggle = root.querySelector<HTMLButtonElement>('[data-motion-toggle]');
  const status = root.querySelector<HTMLElement>('[data-motion-status]');
  let playing = !preference.matches;
  const render = () => {
    for (const image of images) image.src = (playing ? image.dataset.gif : image.dataset.poster)!;
    if (toggle) {
      toggle.textContent = playing ? 'GIF 움직임 멈추기' : 'GIF 움직임 재생';
      toggle.setAttribute('aria-pressed', String(playing));
    }
    if (status) status.textContent = playing ? '단계별 GIF가 원래 속도로 반복돼요.' : '정지 화면을 표시하고 있어요. 설명은 그대로 읽을 수 있어요.';
  };
  const click = () => { playing = !playing; render(); };
  const change = () => { playing = !preference.matches; render(); };
  toggle?.addEventListener('click', click);
  preference.addEventListener('change', change);
  render();
  return () => {
    toggle?.removeEventListener('click', click);
    preference.removeEventListener('change', change);
    for (const image of images) image.src = image.dataset.poster!;
  };
}

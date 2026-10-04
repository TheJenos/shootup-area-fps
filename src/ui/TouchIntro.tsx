/**
 * First-time guide for the on-screen controls: labels pinned next to the real buttons
 * (which are drawn underneath, inactive), plus a plain-text version for screen readers.
 */
export function TouchIntro({ hasSpecial, onDone }: { hasSpecial: boolean; onDone(): void }) {
  return (
    <div id="touch-intro" className="overlay" role="dialog" aria-modal="true" aria-labelledby="touch-intro-title">
      <h2 id="touch-intro-title">How to play on a touch screen</h2>
      <div className="callouts" aria-hidden="true">
        <span className="callout stick">Move<small>push all the way to sprint</small></span>
        <span className="callout look">Drag anywhere here to look</span>
        <span className="callout fire">Fire<small>drag on it to keep aiming</small></span>
        <span className="callout aim">Aim down sights</span>
        <span className="callout jump">Jump</span>
        <span className="callout crouch">Crouch<small>tap while sprinting to slide</small></span>
        <span className="callout reload">Reload</span>
        {hasSpecial && <span className="callout swap">Switch gun</span>}
        <span className="callout slots">Tap an ability to use it</span>
        <span className="callout top">Scoreboard · bag · menu</span>
      </div>
      <p className="sr-only">
        Left half of the screen: a thumb stick to move; push it all the way forward to sprint. Right half: drag to
        look around. Buttons on the right: fire, aim down sights, jump, crouch (tap while sprinting to slide),
        reload and switch gun. Ability slots are at the bottom centre; tap one to use it. The top-left buttons
        open the scoreboard, your bag and the menu.
      </p>
      <button type="button" className="primary" onClick={onDone} autoFocus>Got it</button>
    </div>
  );
}

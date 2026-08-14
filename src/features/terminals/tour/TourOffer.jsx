// (C)
// One-time corner card offering the tour after onboarding. Either button
// writes phn.tourDone via the caller (the offer never returns); Start opens
// the tour.
export default function TourOffer({ onStart, onDismiss }) {
  return (
    <div className="phn-tour-offer" role="dialog" aria-label="Take the tour?">
      <div className="phn-tour-offer-title">New here?</div>
      <div className="phn-tour-offer-body">Take the 2-minute tour of everything.</div>
      <div className="phn-tour-offer-btns">
        <button className="phn-tour-btn primary" onClick={onStart}>Start tour</button>
        <button className="phn-tour-btn quiet" onClick={onDismiss}>No thanks</button>
      </div>
    </div>
  );
}

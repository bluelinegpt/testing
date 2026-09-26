import { MessageState } from "../components/States.js";

/**
 * A reserved marketplace route that has no implementation yet.
 *
 * Search, categories, cart, checkout, account and tracking all land here. The
 * route exists so the slug is protected and so a deep link never 404s; the
 * content is an honest "not available yet" rather than a fabricated screen.
 */
export function ReservedRoutePage() {
  return (
    <div className="store-container">
      <MessageState bodyKey="home.app.body" titleKey="home.app.title" />
    </div>
  );
}

import { Input } from "./ui";
/** Lets users move an in-progress sign-in to another browser. */
export default function BrowserSignInLink({ url }: { url: string }) {
  if (!url) return null;
  return (
    <details>
      <summary>Browser didn’t open?</summary>
      <label>
        Copy this sign-in link into your browser
        <Input
          aria-label="Sign-in link"
          type="text"
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
      </label>
    </details>
  );
}

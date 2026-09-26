import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { Markdown } from "../www/src/components/blog/Markdown";

it("renders unsupported headings as escaped text and always advances", () => {
  for (const body of [
    "#",
    "#Title",
    "#### Heading",
    "## Supported",
    "### Supported",
    "",
    "paragraph\n#Title\n<script>alert(1)</script>",
  ]) {
    const html = renderToStaticMarkup(<Markdown body={body} />);
    expect(html).not.toContain("<script>");
    if (body === "#Title") expect(html).toContain("#Title");
  }
});

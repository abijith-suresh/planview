import { A } from "@solidjs/router";

type WordmarkProps = {
  inverse?: boolean;
  href?: string;
};

export default function Wordmark(props: WordmarkProps) {
  return (
    <A class="wordmark" classList={{ "wordmark-inverse": props.inverse }} href={props.href ?? "/"}>
      <span class="wordmark-mark" aria-hidden="true">
        pv
      </span>
      <span>planview</span>
    </A>
  );
}

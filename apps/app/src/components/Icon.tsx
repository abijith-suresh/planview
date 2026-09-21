import { Match, Switch } from "solid-js";

export type IconName =
  | "copy"
  | "external"
  | "file"
  | "grid"
  | "lock"
  | "log-out"
  | "plus"
  | "trash";

type IconProps = {
  name: IconName;
  size?: number;
};

export default function Icon(props: IconProps) {
  return (
    <svg
      aria-hidden="true"
      class="icon"
      fill="none"
      height={props.size ?? 16}
      viewBox="0 0 24 24"
      width={props.size ?? 16}
      xmlns="http://www.w3.org/2000/svg"
    >
      <Switch>
        <Match when={props.name === "grid"}>
          <rect height="5" rx="1" stroke="currentColor" stroke-width="1.7" width="5" x="3" y="3" />
          <rect height="5" rx="1" stroke="currentColor" stroke-width="1.7" width="5" x="16" y="3" />
          <rect height="5" rx="1" stroke="currentColor" stroke-width="1.7" width="5" x="3" y="16" />
          <rect
            height="5"
            rx="1"
            stroke="currentColor"
            stroke-width="1.7"
            width="5"
            x="16"
            y="16"
          />
        </Match>
        <Match when={props.name === "file"}>
          <path
            d="M6.75 2.75h6.1L17.25 7v13.25H6.75a1.5 1.5 0 0 1-1.5-1.5v-14.5a1.5 1.5 0 0 1 1.5-1.5Z"
            stroke="currentColor"
            stroke-linejoin="round"
            stroke-width="1.7"
          />
          <path
            d="M12.75 2.9V7h4.1M8.5 11h6.8M8.5 14.5h6.8"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-width="1.7"
          />
        </Match>
        <Match when={props.name === "plus"}>
          <path
            d="M12 5v14M5 12h14"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-width="1.8"
          />
        </Match>
        <Match when={props.name === "external"}>
          <path
            d="M13 4h7v7M20 4l-9 9"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.7"
          />
          <path
            d="M18 13.5v4.75a1.75 1.75 0 0 1-1.75 1.75H5.75A1.75 1.75 0 0 1 4 18.25V7.75A1.75 1.75 0 0 1 5.75 6H10.5"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-width="1.7"
          />
        </Match>
        <Match when={props.name === "copy"}>
          <rect
            height="11.5"
            rx="1.75"
            stroke="currentColor"
            stroke-width="1.7"
            width="11.5"
            x="8.5"
            y="8.5"
          />
          <path
            d="M15.5 8.25V6.75A1.75 1.75 0 0 0 13.75 5H6.75A1.75 1.75 0 0 0 5 6.75v7A1.75 1.75 0 0 0 6.75 15.5h1.5"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-width="1.7"
          />
        </Match>
        <Match when={props.name === "trash"}>
          <path
            d="M4.5 7.25h15M9 7.25V4.5h6v2.75M7 7.25l.75 12.25h8.5L17 7.25"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.7"
          />
          <path
            d="M10 10.5v5.5M14 10.5v5.5"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-width="1.7"
          />
        </Match>
        <Match when={props.name === "lock"}>
          <rect
            height="9"
            rx="1.75"
            stroke="currentColor"
            stroke-width="1.7"
            width="14"
            x="5"
            y="10"
          />
          <path
            d="M8 10V7.5a4 4 0 0 1 8 0V10M12 14v2"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-width="1.7"
          />
        </Match>
        <Match when={props.name === "log-out"}>
          <path
            d="M14 5h3.25A1.75 1.75 0 0 1 19 6.75v10.5A1.75 1.75 0 0 1 17.25 19H14"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-width="1.7"
          />
          <path
            d="M11 8l4 4-4 4M15 12H5"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.7"
          />
        </Match>
      </Switch>
    </svg>
  );
}

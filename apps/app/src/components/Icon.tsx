import { Match, Switch } from "solid-js";

export type IconName =
  | "book"
  | "clock"
  | "copy"
  | "external"
  | "file"
  | "github"
  | "grid"
  | "lock"
  | "log-out"
  | "plus"
  | "settings"
  | "terminal"
  | "trash"
  | "upload"
  | "x";

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
        <Match when={props.name === "github"}>
          <path
            d="M9 19c-4.3 1.5-4.3-2.5-6-3m12 6v-3.7c0-1 .1-1.4-.5-2 2.7-.3 5.5-1.3 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.1s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.1A4.6 4.6 0 0 0 4 9.3c0 4.6 2.8 5.7 5.5 6-.6.6-.6 1.2-.5 2V21.5"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.7"
          />
        </Match>
        <Match when={props.name === "x"}>
          <path
            d="M18 6L6 18M6 6l12 12"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.7"
          />
        </Match>
        <Match when={props.name === "upload"}>
          <path
            d="M12 15.5v-11m0 0L7.5 9M12 4.5L16.5 9"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.7"
          />
          <path
            d="M4 16.5v2A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5v-2"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-width="1.7"
          />
        </Match>
        <Match when={props.name === "terminal"}>
          <path
            d="M5 8l4 4-4 4"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.7"
          />
          <path d="M12 17.5h7" stroke="currentColor" stroke-linecap="round" stroke-width="1.7" />
        </Match>
        <Match when={props.name === "book"}>
          <path
            d="M3 19.5A2.5 2.5 0 0 1 5.5 17H20V3H5.5A2.5 2.5 0 0 0 3 5.5v14Zm0 0A2.5 2.5 0 0 0 5.5 22H20v-4.5"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.7"
          />
          <path
            d="M8 7.5h7M8 11h5"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-width="1.7"
          />
        </Match>
        <Match when={props.name === "clock"}>
          <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7" />
          <path
            d="M12 7v5l3.5 2"
            stroke="currentColor"
            stroke-linecap="round"
            stroke-linejoin="round"
            stroke-width="1.7"
          />
        </Match>
        <Match when={props.name === "settings"}>
          <circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.7" />
          <path
            d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"
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

import { onCleanup, onMount } from "solid-js";
import Icon from "~/components/Icon";

type Props = {
  id: string;
  title: string;
  onCopy: () => void;
  onDelete: () => void;
  disabled: boolean;
};

export default function DocumentActions(props: Props) {
  let disclosure!: HTMLDetailsElement;
  let trigger!: HTMLElement;
  const close = (restoreFocus = false) => {
    disclosure.open = false;
    if (restoreFocus) trigger.focus();
  };
  onMount(() => {
    const dismiss = (event: PointerEvent) => {
      if (disclosure.open && !disclosure.contains(event.target as Node)) close();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && disclosure.open) {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", handleEscape);
    onCleanup(() => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", handleEscape);
    });
  });
  return (
    <details
      ref={disclosure}
      class="document-disclosure"
      name="document-actions"
      onFocusOut={(event) => {
        if (!disclosure.contains(event.relatedTarget as Node | null)) close();
      }}
    >
      <summary
        ref={trigger}
        id={`document-actions-${props.id}`}
        class="icon-button"
        aria-label={`Actions for ${props.title}`}
      >
        <Icon name="more" size={20} />
      </summary>
      <div class="document-action-options">
        <button
          type="button"
          onClick={() => {
            close(true);
            props.onCopy();
          }}
        >
          <Icon name="copy" />
          Copy link
        </button>
        <button
          type="button"
          class="action-danger"
          disabled={props.disabled}
          onClick={() => {
            close();
            props.onDelete();
          }}
        >
          <Icon name="trash" />
          Delete
        </button>
      </div>
    </details>
  );
}

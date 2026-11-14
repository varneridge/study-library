import { forwardRef } from "react";
import { Icon } from "./icons";

// One search field for every page that filters or searches: the same box, the same clear
// button (one tap, as the design skill asks), and the same keys. Escape clears the text,
// and a second Escape leaves the field. Enter runs onEnter when given.
export const SearchField = forwardRef<HTMLInputElement, {
  value: string;
  onChange: (next: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  autoFocus?: boolean;
  onEnter?: () => void;
}>(function SearchField({ value, onChange, label, placeholder, className, inputClassName, autoFocus, onEnter }, ref) {
  return (
    <div className={`search-wrap${className ? ` ${className}` : ""}`}>
      <input
        ref={ref}
        type="search"
        className={inputClassName}
        value={value}
        placeholder={placeholder}
        aria-label={label}
        autoFocus={autoFocus}
        inputMode="search"
        enterKeyHint="search"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && onEnter) { e.preventDefault(); onEnter(); }
          if (e.key === "Escape") {
            e.preventDefault();
            if (value) onChange("");
            else e.currentTarget.blur();
          }
        }}
      />
      {value && (
        <button type="button" className="search-clear icon-button" aria-label="Clear search" onClick={() => onChange("")}>
          <Icon name="close" size={16} />
        </button>
      )}
    </div>
  );
});

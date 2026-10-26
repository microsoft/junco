; Derived from tree-sitter-elisp-1.7.2 queries/tags.scm (MIT); junco additions below the marker.
;; defun/defsubst
(function_definition name: (symbol) @name) @definition.function

;; Treat macros as function definitions for the sake of TAGS.
(macro_definition name: (symbol) @name) @definition.function

; --- junco additions ---

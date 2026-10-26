; Derived from tree-sitter-ruby 0.23.1 queries/tags.scm (MIT); junco additions below the marker.
; Removed stock bare [(identifier) (constant)] @reference.call pattern (needs tree-sitter-tags #is-not? local).
; Method definitions

(
  (comment)* @doc
  .
  [
    (method
      name: (_) @name) @definition.method
    (singleton_method
      name: (_) @name) @definition.method
  ]
  (#strip! @doc "^#\\s*")
  (#select-adjacent! @doc @definition.method)
)

(alias
  name: (_) @name) @definition.method

(setter
  (identifier) @ignore)

; Class definitions

(
  (comment)* @doc
  .
  [
    (class
      name: [
        (constant) @name
        (scope_resolution
          name: (_) @name)
      ]) @definition.class
    (singleton_class
      value: [
        (constant) @name
        (scope_resolution
          name: (_) @name)
      ]) @definition.class
  ]
  (#strip! @doc "^#\\s*")
  (#select-adjacent! @doc @definition.class)
)

; Module definitions

(
  (module
    name: [
      (constant) @name
      (scope_resolution
        name: (_) @name)
    ]) @definition.module
)

; Calls

(call method: (identifier) @name) @reference.call

; --- junco additions ---
((call method: (identifier) @import.kind arguments: (argument_list (string (string_content) @import.module))) @import (#match? @import.kind "^(require|require_relative)$"))
(superclass (constant) @name) @reference.extends
((call method: (identifier) @_i arguments: (argument_list (constant) @name)) @reference.implements (#match? @_i "^(include|extend|prepend)$"))

; Derived from tree-sitter-kotlin-sg 0.4.1 queries/tags.scm (MIT); junco additions below the marker.
; Classes
(class_declaration
  (type_identifier) @name) @definition.class

; Objects
(object_declaration
  (type_identifier) @name) @definition.class

; Functions (top-level and member)
(function_declaration
  (simple_identifier) @name) @definition.function

; Properties
(property_declaration
  (variable_declaration
    (simple_identifier) @name)) @definition.constant

; Enum entries
(enum_entry
  (simple_identifier) @name) @definition.constant

; Type aliases
(type_alias
  (type_identifier) @name) @definition.type

; Companion objects (only named ones)
(companion_object
  (type_identifier) @name) @definition.class

; Function calls
(call_expression
  (simple_identifier) @name) @reference.call

; Method calls via navigation
(call_expression
  (navigation_expression
    (navigation_suffix
      (simple_identifier) @name))) @reference.call

; Constructor invocations (class references)
(constructor_invocation
  (user_type
    (type_identifier) @name)) @reference.class

; --- junco additions ---
(import_header (identifier) @import.module) @import
(delegation_specifier (user_type (type_identifier) @name)) @reference.extends

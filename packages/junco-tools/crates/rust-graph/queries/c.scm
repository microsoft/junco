; Derived from tree-sitter-c 0.24.2 queries/tags.scm (MIT); junco additions below the marker.
(struct_specifier name: (type_identifier) @name body:(_)) @definition.class

(declaration type: (union_specifier name: (type_identifier) @name)) @definition.class

(function_declarator declarator: (identifier) @name) @definition.function

(type_definition declarator: (type_identifier) @name) @definition.type

(enum_specifier name: (type_identifier) @name) @definition.type

; --- junco additions ---
(preproc_include path: (string_literal) @import.module) @import
(preproc_include path: (system_lib_string) @import.module) @import
(call_expression function: (identifier) @name) @reference.call

; Derived from tree-sitter-python 0.25.0 queries/tags.scm (MIT); junco additions below the marker.
(module (expression_statement (assignment left: (identifier) @name) @definition.constant))

(class_definition
  name: (identifier) @name) @definition.class

(function_definition
  name: (identifier) @name) @definition.function

(call
  function: [
      (identifier) @name
      (attribute
        attribute: (identifier) @name)
  ]) @reference.call

; --- junco additions ---
(import_statement name: (dotted_name) @import.module) @import
(import_statement name: (aliased_import name: (dotted_name) @import.module)) @import
(import_from_statement module_name: (dotted_name) @import.module) @import
(import_from_statement module_name: (relative_import) @import.module) @import
(import_from_statement module_name: (dotted_name) @import.module name: (dotted_name) @import.name) @import
(import_from_statement module_name: (relative_import) @import.module name: (dotted_name) @import.name) @import
(import_from_statement module_name: (dotted_name) @import.module name: (aliased_import name: (dotted_name) @import.name)) @import
(import_from_statement module_name: (relative_import) @import.module name: (aliased_import name: (dotted_name) @import.name)) @import
(class_definition superclasses: (argument_list [(identifier) @name (attribute attribute: (identifier) @name)])) @reference.extends

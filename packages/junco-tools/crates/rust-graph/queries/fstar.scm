; Names and imports come from the published grammar. fstar::adjust splits flat
; mutual bindings, extends the module scope, and walks lexical references.
(module_declaration name: (_) @name) @definition.module
(let_declaration name: (_) @name) @definition.function
(val_declaration name: (_) @name) @definition.function
(assume_declaration name: (_) @name) @definition.constant
(type_definition name: (_) @name) @definition.type
(constructor_declaration name: (_) @name) @definition.constant
(record_field_declaration name: (_) @name) @definition.field
(instance_declaration name: (_) @name) @definition.function
(instance_val_declaration name: (_) @name) @definition.function
(effect_declaration name: (_) @name) @definition.type
(effect_abbreviation name: (_) @name) @definition.type
(effect_definition name: (_) @name) @definition.type
(exception_declaration name: (_) @name) @definition.constant

(open_declaration name: (_) @import.module) @import
(include_declaration name: (_) @import.module) @import
(friend_declaration name: (_) @import.module) @import
(module_alias name: (_) @import.kind value: (_) @import.module) @import

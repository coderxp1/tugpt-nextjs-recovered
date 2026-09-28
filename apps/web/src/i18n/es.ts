/**
 * Spanish — the source of truth.
 *
 * Every other dictionary is typed against this one (`en.ts` is
 * `Record<keyof typeof es, string>`), so a key that exists only in English is
 * a compile error and a key missing from English is a compile error. That is
 * what makes "Spanish-first" a property of the build rather than an intention.
 *
 * HOUSE STYLE, so translations do not drift into three registers:
 *
 *   * Chrome — buttons, links, headings — avoids the second person entirely.
 *     "Recargar", not "Recargue" or "Recarga". It sidesteps the tú/usted
 *     question in the ~80% of strings where nobody needs to be addressed.
 *   * Where the reader must be addressed, it is **usted**. TuGPT is sold to
 *     business owners in Ecuador and the AI persona on record already uses
 *     usted with their customers; the dashboard using tú beside it would read
 *     as two products.
 *   * No English left untranslated as a "technical term". `provider` and
 *     `model` are labels a reviewer reads, not identifiers.
 *
 * Placeholders are `{name}` and must appear in every translation of the same
 * key — `dictionaries.test.ts` fails otherwise, because a dropped placeholder
 * is a string that silently renders without the number it was written around.
 */

export const es = {
  'app.description': 'Tu empleado con IA para WhatsApp, llamadas y clientes.',

  'common.loading': 'Cargando…',
  'common.retry': 'Reintentar',
  'common.cancel': 'Cancelar',
  'common.reload': 'Recargar',
  'common.previous': 'Anterior',
  'common.next': 'Siguiente',

  'shell.skipToContent': 'Saltar al contenido',
  'shell.primaryNavLabel': 'Navegación principal',
  'shell.organizationLabel': 'Organización',
  'shell.organizationUnknown': 'Organización no disponible',
  'shell.signOut': 'Cerrar sesión',

  'nav.drafts': 'Borradores',
  'nav.inbox': 'Conversaciones',
  'nav.media': 'Multimedia',

  'media.list.title': 'Multimedia',
  'media.list.loading': 'Cargando trabajos…',
  'media.list.empty':
    'Todavía no hay trabajos de multimedia. Los que genere aparecerán aquí.',
  'media.list.loadFailed': 'No se pudieron cargar los trabajos',
  'media.list.newJob': 'Nuevo trabajo',
  'media.list.pagination': 'Página {page} de {pages}',
  'media.list.gpuSeconds': '{seconds} s de GPU',

  'media.filter.all': 'Todos',
  'media.filter.queued': 'En cola',
  'media.filter.processing': 'Procesando',
  'media.filter.completed': 'Completados',
  'media.filter.cancelled': 'Cancelados',
  'media.filter.dead_lettered': 'Fallidos',

  'media.status.queued': 'En cola',
  'media.status.processing': 'Procesando',
  'media.status.completed': 'Completado',
  'media.status.skipped': 'Omitido',
  'media.status.cancelled': 'Cancelado',
  'media.status.dead_lettered': 'Fallido',

  'media.kind.image': 'Imagen',
  'media.kind.video': 'Video',

  'media.form.title': 'Nuevo trabajo',
  'media.form.kindLabel': 'Tipo',
  'media.form.promptLabel': 'Descripción',
  'media.form.promptPlaceholder': 'Describa la imagen o el video que quiere generar…',
  'media.form.promptCounter': '{count} de {max} caracteres',
  'media.form.promptRequired': 'La descripción no puede estar vacía',
  'media.form.promptTooLong': 'La descripción no puede superar los 1000 caracteres',
  'media.form.negativePromptLabel': 'Descripción negativa (opcional)',
  'media.form.negativePromptPlaceholder': 'Lo que no debe aparecer…',
  'media.form.imageSizeLabel': 'Tamaño',
  'media.form.framesLabel': 'Cuadros',
  'media.form.framesHint': 'De 1 a 81, de la forma 4n+1 (1, 5, 9, …)',
  'media.form.framesInvalid':
    'Los cuadros deben estar entre 1 y 81 y ser de la forma 4n+1 (1, 5, 9, …)',
  'media.form.fpsLabel': 'Cuadros por segundo',
  'media.form.fpsHint': 'De 1 a 30',
  'media.form.fpsInvalid': 'Los cuadros por segundo deben estar entre 1 y 30',
  'media.form.submit': 'Generar',
  'media.form.submitting': 'Enviando…',
  'media.form.submitFailed': 'No se pudo enviar el trabajo',
  'media.form.backToList': 'Volver a la lista',

  'media.detail.loading': 'Cargando el trabajo…',
  'media.detail.loadFailed': 'No se pudo cargar el trabajo',
  'media.detail.notFound': 'No se encontró el trabajo.',
  'media.detail.backToList': 'Volver a la lista',
  'media.detail.created': 'Creado',
  'media.detail.started': 'Iniciado',
  'media.detail.finished': 'Terminado',
  'media.detail.paramsHeading': 'Parámetros',
  'media.detail.gpuSeconds': '{seconds} s de GPU',
  'media.detail.cancelHeading': 'Cancelar el trabajo',
  'media.detail.cancelReasonLabel': 'Motivo de la cancelación',
  'media.detail.cancelReasonPlaceholder': 'Motivo (opcional)',
  'media.detail.cancelling': 'Cancelando…',
  'media.detail.cancelFailed': 'No se pudo cancelar el trabajo',
  'media.detail.resultHeading': 'Resultado',
  'media.detail.resultLoading': 'Obteniendo el enlace del resultado…',
  'media.detail.resultFailed': 'No se pudo obtener el resultado',
  'media.detail.download': 'Descargar',

  // Alias kept for forward compatibility: the API emits QUOTA_EXCEEDED
  // (see media-api/error-mapper.ts); this spelling is translated too so an
  // older client never renders a raw code.
  'errors.MEDIA_QUOTA_EXCEEDED': 'Se alcanzó el límite de trabajos de esta organización',
  'inbox.title': 'Conversaciones',
  'inbox.loading': 'Cargando conversaciones…',
  'inbox.loadFailed': 'No se pudieron cargar las conversaciones',
  'inbox.empty': 'Todavía no hay conversaciones.',
  'inbox.emptyFiltered': 'Ninguna conversación coincide con este filtro.',
  'inbox.retry': 'Reintentar',
  'inbox.next': 'Siguientes',
  'inbox.start': 'Volver al principio',
  'inbox.awaitingReview': 'Borrador por revisar',
  'inbox.lastActivity': 'Última actividad: {at}',
  'inbox.unknownContact': 'Contacto desconocido',
  'inbox.filter.all': 'Todas',
  'inbox.filter.open': 'Abiertas',
  'inbox.filter.needs_human': 'Requieren atención',
  'inbox.filter.closed': 'Cerradas',
  'errors.CONVERSATION_NOT_FOUND': 'Conversación no encontrada',
  'errors.ASSIGNEE_NOT_A_MEMBER': 'Esa persona no es miembro de esta organización',
  'errors.ASSIGNMENT_CONFLICT': 'Otra persona cambió esta conversación primero. Recargue e inténtelo de nuevo.',
  'errors.INVALID_STATUS_TRANSITION': 'Esta conversación no se puede cambiar en su estado actual',
  'inbox.filter.mine': 'Mías',
  'inbox.filter.unassigned': 'Sin asignar',
  'inbox.assignment.all': 'Cualquiera',
  'inbox.filterByStatus': 'Filtrar por estado',
  'inbox.filterByAssignee': 'Filtrar por responsable',
  'inbox.assignedTo': 'Asignada a {name}',
  'inbox.assignedToYou': 'Asignada a usted',
  'inbox.unassigned': 'Sin asignar',
  'inbox.claim': 'Tomar',
  'inbox.release': 'Soltar',
  'inbox.claiming': 'Guardando…',
  'inbox.claimFailed': 'No se pudo cambiar la asignación de la conversación',
  'thread.handoff': 'Pasar a atención humana',
  'thread.returnToAi': 'Devolver a la IA',
  'thread.handedOff': 'La IA no genera borradores para esta conversación.',
  'thread.handoffFailed': 'No se pudo cambiar el estado de la conversación',

  'auth.login.title': 'Iniciar sesión en {app}',
  'auth.login.email': 'Correo electrónico',
  'auth.login.emailPlaceholder': 'usted@ejemplo.com',
  'auth.login.password': 'Contraseña',
  'auth.login.passwordPlaceholder': '••••••••',
  'auth.login.submit': 'Iniciar sesión',
  'auth.login.submitting': 'Iniciando sesión…',
  'auth.logout.pending': 'Cerrando sesión…',
  'auth.callback.pending': 'Completando la autenticación…',

  'drafts.inbox.title': 'Bandeja de borradores',
  'drafts.inbox.loading': 'Cargando borradores…',
  'drafts.inbox.empty':
    'No hay borradores por revisar. Los borradores que genere la IA aparecerán aquí.',
  'drafts.inbox.loadFailed': 'No se pudieron cargar los borradores',
  'drafts.inbox.noPreview': 'Sin vista previa',
  'drafts.inbox.pagination': 'Página {page} de {pages}',

  'drafts.filter.all': 'Todos',
  'drafts.filter.draft': 'Borradores',
  'drafts.filter.approved': 'Aprobados',
  'drafts.filter.rejected': 'Rechazados',

  'drafts.status.draft': 'Borrador',
  'drafts.status.approved': 'Aprobado',
  'drafts.status.rejected': 'Rechazado',

  'drafts.detail.title': 'Revisión del borrador',
  'drafts.detail.loading': 'Cargando el borrador…',
  'drafts.detail.loadFailed': 'No se pudo cargar el borrador',
  'drafts.detail.notFound': 'No se encontró el borrador.',
  'drafts.detail.backToInbox': 'Volver a la bandeja',
  'drafts.detail.stale':
    'Otro revisor modificó este borrador. Recargue antes de continuar.',
  'drafts.detail.version': 'Versión: {version}',
  'drafts.detail.provider': 'Proveedor: {provider}',
  'drafts.detail.model': 'Modelo: {model}',
  'drafts.detail.created': 'Creado: {at}',
  'drafts.detail.updated': 'Actualizado: {at}',
  'drafts.detail.reviewed': 'Revisado: {at}',
  'drafts.detail.rejected': 'Rechazado: {at}',
  'drafts.detail.contentHeading': 'Contenido del borrador',
  'drafts.detail.noContent': 'Sin contenido disponible',
  'drafts.detail.sourceHeading': 'Mensaje del cliente',
  'drafts.detail.noSourceBody': 'El mensaje no tiene texto',
  'drafts.detail.direction': 'Dirección: {direction}',
  'drafts.detail.received': 'Recibido: {at}',
  'drafts.detail.from': 'De: {contact}',
  'drafts.detail.conversationHeading': 'Conversación',
  'drafts.thread.heading': 'Conversación con el cliente',
  'drafts.thread.loading': 'Cargando la conversación…',
  'drafts.thread.loadFailed': 'No se pudo cargar la conversación',
  'drafts.thread.empty': 'Todavía no hay mensajes en esta conversación.',
  'drafts.thread.olderHidden':
    'Se muestran los {count} mensajes más recientes. Hay mensajes anteriores.',
  'drafts.thread.sourceOutOfWindow':
    'El mensaje que responde este borrador es anterior a los mensajes que se ven aquí. Está arriba, en «Mensaje del cliente».',
  'drafts.thread.sourceLabel': 'Este borrador responde a este mensaje',
  'drafts.thread.fromCustomer': 'Cliente',
  'drafts.thread.fromBusiness': 'Negocio',
  'drafts.thread.noBody': 'Mensaje sin texto',
  'drafts.thread.retry': 'Reintentar',
  'drafts.detail.conversationStatus': 'Estado: {status}',
  'drafts.detail.featureUnavailable':
    'La generación de borradores con IA no está disponible para su organización.',

  'drafts.direction.inbound': 'entrante',
  'drafts.direction.outbound': 'saliente',

  'drafts.conversation.open': 'abierta',
  'drafts.conversation.needs_human': 'requiere atención humana',
  'drafts.conversation.closed': 'cerrada',

  'drafts.actions.approve': 'Aprobar',
  'drafts.actions.reject': 'Rechazar',
  'drafts.actions.edit': 'Editar',
  'drafts.actions.save': 'Guardar cambios',
  'drafts.actions.saving': 'Guardando…',
  'drafts.actions.processing': 'Procesando…',
  'drafts.actions.editPlaceholder': 'Escriba aquí el texto revisado del borrador…',
  'drafts.actions.emptyBody': 'El borrador no puede quedar vacío',
  'drafts.actions.permissionDenied': 'No tiene permiso para realizar esta acción.',
  'drafts.actions.approveFailed': 'No se pudo aprobar el borrador',
  'drafts.actions.rejectFailed': 'No se pudo rechazar el borrador',
  'drafts.actions.editFailed': 'No se pudo guardar la edición',

  'drafts.revisions.heading': 'Historial de versiones',
  'drafts.revisions.loadFailed': 'No se pudo cargar el historial de versiones',
  'drafts.revisions.version': 'Versión {version}',
  'drafts.revisions.current': '(actual)',
  'drafts.revisions.byUser': 'Editado por una persona',
  'drafts.revisions.byAi': 'Generado por IA',

  'drafts.events.heading': 'Eventos de revisión',
  'drafts.events.loadFailed': 'No se pudieron cargar los eventos',
  'drafts.events.approve': 'Aprobado',
  'drafts.events.edit': 'Editado',
  'drafts.events.reject': 'Rechazado',

  // Keyed by the `code` the API returns alongside its message, not by the
  // message. `apps/web/src/lib/draft-api/error-mapper.ts` is the list; the
  // server keeps sending English, and the server's text is the fallback when a
  // code arrives that this dictionary has not caught up with.
  'errors.UNAUTHENTICATED': 'Su sesión no está activa. Vuelva a iniciar sesión.',
  'errors.DRAFT_NOT_FOUND': 'No se encontró el borrador',
  'errors.FORBIDDEN': 'No tiene permiso para realizar esta acción',
  'errors.STALE_VERSION':
    'Otro revisor modificó este borrador. Recargue e inténtelo de nuevo.',
  'errors.INVALID_STATE_TRANSITION':
    'Este borrador no se puede modificar en su estado actual',
  'errors.INVALID_BODY': 'El borrador no puede quedar vacío',
  'errors.INVITATION_NOT_FOUND': 'No se encontró la invitación',
  'errors.INVITATION_ALREADY_PENDING': 'Esa dirección ya tiene una invitación pendiente. Cancélela antes de enviar otra.',
  'errors.INVITATION_NOT_PENDING': 'Esta invitación ya fue usada o retirada',
  'errors.INVITATION_EXPIRED': 'Esta invitación venció. Pida una nueva.',
  'errors.INVITATION_WRONG_ACCOUNT': 'Esta invitación se envió a otro correo. Inicie sesión con esa dirección para aceptarla.',
  'errors.ALREADY_A_MEMBER': 'Esa persona ya pertenece a esta organización',
  'errors.ROLE_ABOVE_YOUR_OWN': 'No puede invitar a alguien con un rol superior al suyo',
  'errors.INVALID_EMAIL': 'Esa dirección de correo no es válida',
  'errors.INTERNAL_ERROR': 'Ocurrió un error inesperado',
  // Media API (media-api/error-mapper.ts). Spanish is the source of truth;
  // the server sends the English sentence as the fallback.
  'errors.QUOTA_EXCEEDED': 'Su organización alcanzó el límite de generación de medios',
  'errors.MEDIA_IDEMPOTENCY_CONFLICT': 'Este envío ya se realizó con un contenido diferente',
  'errors.MEDIA_CONCURRENCY_EXCEEDED': 'Su organización ya tiene un trabajo de medios en curso',
  'errors.MEDIA_JOB_NOT_FOUND': 'No se encontró el trabajo de medios',
  'errors.INVALID_MEDIA_JOB_STATE': 'Este trabajo de medios no se puede modificar en su estado actual',
  'errors.MEDIA_RESULT_NOT_FOUND': 'Este trabajo de medios aún no tiene resultado',
  'errors.FEATURE_UNAVAILABLE': 'La generación de medios no está disponible',
  'errors.INVALID_REQUEST': 'La solicitud de medios no es válida',
} as const;

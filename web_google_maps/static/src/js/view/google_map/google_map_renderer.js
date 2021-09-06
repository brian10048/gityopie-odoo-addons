odoo.define('web_google_maps.GoogleMapRenderer', function (require) {
    'use strict';

    const BasicRenderer = require('web.BasicRenderer');
    const core = require('web.core');
    const QWeb = require('web.QWeb');
    const session = require('web.session');
    const utils = require('web.utils');
    const KanbanRecord = require('web.KanbanRecord');
    const Utils = require('web_google_maps.Utils');
    const GoogleMapSidebar = require('web_google_maps.GoogleMapSidebar');

    const qweb = core.qweb;
    const _lt = core._lt;

    const MARKER_COLORS = [
        'black',
        'blue',
        'brown',
        'cyan',
        'fuchsia',
        'green',
        'grey',
        'lime',
        'maroon',
        'navy',
        'olive',
        'orange',
        'pink',
        'purple',
        'red',
        'teal',
        'white',
        'yellow',
    ];

    const GoogleMapRecord = KanbanRecord.extend({
        init: function (parent, state, options) {
            this._super.apply(this, arguments);
            this.fieldsInfo = state.fieldsInfo.google_map;
        },
    });

    function findInNode(node, predicate) {
        if (predicate(node)) {
            return node;
        }
        if (!node.children) {
            return undefined;
        }
        for (let i = 0; i < node.children.length; i++) {
            if (findInNode(node.children[i], predicate)) {
                return node.children[i];
            }
        }
    }

    function qwebAddIf(node, condition) {
        if (node.attrs[qweb.prefix + '-if']) {
            condition = _.str.sprintf('(%s) and (%s)', node.attrs[qweb.prefix + '-if'], condition);
        }
        node.attrs[qweb.prefix + '-if'] = condition;
    }

    function transformQwebTemplate(node, fields) {
        // Process modifiers
        if (node.tag && node.attrs.modifiers) {
            const modifiers = node.attrs.modifiers || {};
            if (modifiers.invisible) {
                qwebAddIf(node, _.str.sprintf('!kanban_compute_domain(%s)', JSON.stringify(modifiers.invisible)));
            }
        }
        switch (node.tag) {
            case 'button':
            case 'a':
                const type = node.attrs.type || '';
                if (_.indexOf('action,object,edit,open,delete,url,set_cover'.split(','), type) !== -1) {
                    _.each(node.attrs, function (v, k) {
                        if (_.indexOf('icon,type,name,args,string,context,states,kanban_states'.split(','), k) !== -1) {
                            node.attrs['data-' + k] = v;
                            delete node.attrs[k];
                        }
                    });
                    if (node.attrs['data-string']) {
                        node.attrs.title = node.attrs['data-string'];
                    }
                    if (node.tag === 'a' && node.attrs['data-type'] !== 'url') {
                        node.attrs.href = '#';
                    } else {
                        node.attrs.type = 'button';
                    }

                    const action_classes = ' oe_kanban_action oe_kanban_action_' + node.tag;
                    if (node.attrs['t-attf-class']) {
                        node.attrs['t-attf-class'] += action_classes;
                    } else if (node.attrs['t-att-class']) {
                        node.attrs['t-att-class'] += " + '" + action_classes + "'";
                    } else {
                        node.attrs['class'] = (node.attrs['class'] || '') + action_classes;
                    }
                }
                break;
        }
        if (node.children) {
            for (let i = 0, ii = node.children.length; i < ii; i++) {
                transformQwebTemplate(node.children[i], fields);
            }
        }
    }

    const GoogleMapRenderer = BasicRenderer.extend({
        className: 'o_google_map_view',
        template: 'GoogleMapView.MapView',
        events: _.extend({}, BasicRenderer.prototype.events, {
            'click .toggle_right_sidenav': 'onToggleRightSidenav',
        }),
        onToggleRightSidenav: function () {
            this.$('.o_map_right_sidebar').toggleClass('closed').toggleClass('open');
            this.$('.o_map_right_sidebar').find('.toggle_right_sidenav > button').toggleClass('closed');
            if (this.$('.o_map_right_sidebar').hasClass('closed')) {
                var current_center = this.gmap.getCenter();
                google.maps.event.trigger(this.gmap, 'resize');
                this.gmap.setCenter(current_center);
            }
        },
        /**
         * @override
         *
         * @param {*} parent
         * @param {*} state
         * @param {*} params
         */
        init: function (parent, state, params) {
            this._super.apply(this, arguments);
            this.widgets = [];

            this.qweb = new QWeb(
                session.debug,
                {
                    _s: session.origin,
                },
                false
            );
            const templates = findInNode(this.arch, function (n) {
                return n.tag === 'templates';
            });
            transformQwebTemplate(templates, state.fields);
            this.qweb.add_template(utils.json_node_to_xml(templates));
            this.recordOptions = _.extend({}, params.record_options, {
                qweb: this.qweb,
                viewType: 'google_map',
            });
            this.state = state;
            this.mapMode = params.map_mode ? params.map_mode : 'geometry';
            this.gestureHandling =
                ['cooperative', 'greedy', 'none', 'auto'].indexOf(params.gestureHandling) === -1
                    ? 'auto'
                    : params.gestureHandling;
            this._initLibraryProperties(params);
        },
        /**
         *
         * @param {*} params
         */
        _initLibraryProperties: function (params) {
            const func_name = 'set_property_' + this.mapMode;
            this[func_name].call(this, params);
        },
        /**
         *
         * @param {*} params
         */
        set_property_geometry: function (params) {
            this.defaultMarkerColor = 'red';
            this.markers = [];
            this.iconUrl = '/web_google_maps/static/src/img/markers/';
            this.fieldLat = params.fieldLat;
            this.fieldLng = params.fieldLng;
            this.markerColor = params.markerColor;
            this.markerColors = params.markerColors;
            this.markerClusterConfig = params.markerClusterConfig;
            this.disableClusterMarker = params.disableClusterMarker;
            this.sidebarRender = null;
            this.googleMapStyle = params.googleMapStyle;
        },
        /**
         * @override
         */
        start: function () {
            this._initMap();
            return this._super();
        },
        /**
         * Style the map
         * @private
         */
        _getMapTheme: async function () {
            const self = this;
            const themes = Utils.MAP_THEMES;
            const update_map = function (style) {
                const styledMapType = new google.maps.StyledMapType(themes[style], {
                    name: _lt('Styled Map'),
                });
                self.gmap.setOptions({
                    mapTypeControlOptions: {
                        mapTypeIds: ['roadmap', 'satellite', 'hybrid', 'terrain', 'styled_map'],
                    },
                });
                // Associate the styled map with the MapTypeId and set it to display.
                if (self.theme === 'default') return;
                self.gmap.mapTypes.set('styled_map', styledMapType);
                self.gmap.setMapTypeId('styled_map');
            };
            if (this.googleMapStyle) {
                update_map(this.googleMapStyle);
            } else if (!this.theme) {
                const data = await this._rpc({ route: '/web/map_theme' });
                if (data.theme && Object.prototype.hasOwnProperty.call(themes, data.theme)) {
                    this.theme = data.theme;
                    update_map(data.theme);
                }
            }
        },
        /**
         * Initialize map
         * @private
         */
        _initMap: function () {
            this.infoWindow = new google.maps.InfoWindow();
            this.$right_sidebar = this.$('.o_map_right_sidebar');
            this.$('.o_google_map_view').empty();
            this.gmap = new google.maps.Map(this.$('.o_google_map_view').get(0), {
                mapTypeId: google.maps.MapTypeId.ROADMAP,
                minZoom: 2,
                maxZoom: 20,
                fullscreenControl: true,
                mapTypeControl: true,
                gestureHandling: this.gestureHandling,
            });
            this._getMapTheme();
            const func_name = '_post_load_map_' + this.mapMode;
            this[func_name].call(this);
        },
        /**
         *
         */
        _post_load_map_geometry: function () {
            if (!this.disableClusterMarker) {
                this._initMarkerCluster();
            }
            let $btn_geolocate_user = $(qweb.render('GoogleMapView.GeolocateUser', { widget: this }));
            if (!this.$btn_geolocate_user_loaded) {
                this.btn_geolocate_user_loaded = true;
                this.gmap.controls[google.maps.ControlPosition.RIGHT_BOTTOM].push($btn_geolocate_user.get(0));
            }
            $btn_geolocate_user.on('click', 'button', (ev) => {
                ev.preventDefault();
                this.trigger_up('geolocate_user_location', {});
            });
        },
        /**
         *
         */
        _initMarkerCluster: function () {
            if (!this.markerClusterConfig.imagePath) {
                this.markerClusterConfig['imagePath'] = '/web_google_maps/static/lib/markerclusterer/img/m';
            }
            this.markerCluster = new MarkerClusterer(this.gmap, [], this.markerClusterConfig);
        },
        /**
         * Compute marker color
         * @param {any} record
         * @return string
         */
        _getIconColor: function (record) {
            if (this.markerColor) {
                return this.markerColor;
            }

            if (!this.markerColors) {
                return this.defaultMarkerColor;
            }

            let color = null;
            let expression = null;
            let result = this.defaultMarkerColor;

            for (let i = 0; i < this.markerColors.length; i++) {
                color = this.markerColors[i][0];
                expression = this.markerColors[i][1];
                if (py.PY_isTrue(py.evaluate(expression, record.evalContext))) {
                    result = color;
                    break;
                }
            }
            return result;
        },
        /**
         * Create marker
         * @param {any} latLng: instance of google LatLng
         * @param {any} record
         * @param {string} color
         */
        _createMarker: function (latLng, record, color) {
            const options = {
                position: latLng,
                map: this.gmap,
                animation: google.maps.Animation.DROP,
                _odooRecord: record,
                _odooMarkerColor: color,
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    fillColor: 'red',
                    fillOpacity: 0.9,
                    strokeWeight: 2,
                    strokeColor: '#ededed',
                    rotation: 0,
                    scale: 8,
                },
            };
            if (color) {
                options.icon.fillColor = color;
                options._odooMarkerColor = color;
            }
            const marker = new google.maps.Marker(options);
            this._clusterAddMarker(marker);
        },
        /**
         * Get marker icon color path
         * @param {String} color
         * DEPRECATED
         */
        _getIconColorPath: function (color) {
            const defaultPath = '/web_google_maps/static/src/img/markers/';
            if (MARKER_COLORS.indexOf(color) >= 0) {
                return defaultPath + color + '.png';
            }
            return this.iconUrl + color + '.png';
        },
        /**
         * Handle Multiple Markers present at the same coordinates
         */
        _clusterAddMarker: function (marker) {
            let markers;
            if (this.disableClusterMarker) {
                markers = this.markers;
            } else {
                markers = this.markerCluster.getMarkers();
            }
            const existingRecords = [];
            if (markers.length > 0) {
                const position = marker.getPosition();
                markers.forEach((_cMarker) => {
                    if (position && position.equals(_cMarker.getPosition())) {
                        marker.setMap(null);
                        existingRecords.push(_cMarker._odooRecord);
                    }
                });
            }
            this.markers.push(marker);
            if (!this.disableClusterMarker) {
                this.markerCluster.addMarker(marker);
            }
            google.maps.event.addListener(marker, 'click', this._markerInfoWindow.bind(this, marker, existingRecords));
        },
        /**
         * Marker info window
         * @param {any} marker: instance of google marker
         * @param {any} record
         * @return function
         */
        _markerInfoWindow: function (marker, currentRecords) {
            let _content = '';
            const markerRecords = [];

            const markerDiv = document.createElement('div');
            markerDiv.className = 'o_kanban_view';

            const markerContent = document.createElement('div');
            markerContent.className = 'o_kanban_group';

            if (currentRecords.length > 0) {
                currentRecords.forEach((_record) => {
                    _content = this._generateMarkerInfoWindow(_record);
                    markerRecords.push(_content);
                    _content.appendTo(markerContent);
                });
            }

            const markerIwContent = this._generateMarkerInfoWindow(marker._odooRecord);
            markerIwContent.appendTo(markerContent);

            markerDiv.appendChild(markerContent);
            this.infoWindow.setContent(markerDiv);
            this.infoWindow.open(this.gmap, marker);
        },
        /**
         * @private
         */
        _generateMarkerInfoWindow: function (record) {
            const markerIw = new GoogleMapRecord(this, record, this.recordOptions);
            return markerIw;
        },
        /**
         * Render markers
         * @private
         * @param {Object} record
         */
        _renderMarkers: function () {
            let color = null;
            let latLng = null;
            let lat = null;
            let lng = null;
            this.state.data.forEach((record) => {
                color = this._getIconColor(record);
                lat = typeof record.data[this.fieldLat] === 'number' ? record.data[this.fieldLat] : 0.0;
                lng = typeof record.data[this.fieldLng] === 'number' ? record.data[this.fieldLng] : 0.0;
                if (lat !== 0.0 || lng !== 0.0) {
                    latLng = new google.maps.LatLng(lat, lng);
                    this._createMarker(latLng, record, color);
                }
            });
        },
        /**
         * Default location
         */
        _getDefaultCoordinate: function () {
            return new google.maps.LatLng(0.0, 0.0);
        },
        /**
         * @override
         */
        _renderView: function () {
            const func_map_center = '_map_center_' + this.mapMode;
            this._clearMarkerClusters();
            this._renderMarkers();
            return this._super
                .apply(this, arguments)
                .then(this[func_map_center].bind(this))
                .then(this._renderSidebar.bind(this));
        },
        /**
         * Centering map
         */
        _map_center_geometry: function () {
            const mapBounds = new google.maps.LatLngBounds();

            this.markers.forEach((marker) => {
                mapBounds.extend(marker.getPosition());
            });
            this.gmap.fitBounds(mapBounds);

            this.map_has_centered = true;
            google.maps.event.addListenerOnce(this.gmap, 'idle', () => {
                google.maps.event.trigger(this.gmap, 'resize');
                if (this.gmap.getZoom() > 17) this.gmap.setZoom(17);
            });
        },
        /**
         * Clear marker clusterer and list markers
         * @private
         */
        _clearMarkerClusters: function () {
            if (this.markerCluster) {
                this.markerCluster.clearMarkers();
            }
            this.markers = [];
        },
        setMarkerDraggable: function () {
            this.markers[0].setOptions({
                draggable: true,
                animation: google.maps.Animation.BOUNCE,
            });
        },
        disableMarkerDraggable: function () {
            this.markers[0].setOptions({
                draggable: false,
                animation: google.maps.Animation.DROP,
            });
        },
        /**
         * Render list of `display_name` of records loaded in the map
         */
        _renderSidebar: function () {
            this.sidebarRender = new GoogleMapSidebar(this, this.state.data);
            const $rightSidebar = this.$right_sidebar.find('.content');
            $rightSidebar.empty();
            this.sidebarRender.appendTo($rightSidebar);
        },
    });

    return {
        GoogleMapRenderer: GoogleMapRenderer,
        GoogleMapRecord: GoogleMapRecord,
    };
});

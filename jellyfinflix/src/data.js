// What rows each browse screen shows, and how to fetch them.
import { S, get, COMMON, slim } from './api.js';

const P = (o) => Object.assign({}, COMMON, o);
const items = (r) => (Array.isArray(r) ? r : r.Items || []).map(slim);

const resume = (types) => () => get('/Users/{U}/Items/Resume', P({ Limit: 24, MediaTypes: 'Video', IncludeItemTypes: types }), 30000).then(items);
const nextUp = () => get('/Shows/NextUp', P({ UserId: '{U}', Limit: 24, EnableResumable: false, EnableRewatching: false }), 30000).then(items);
const favs = (types) => () => get('/Users/{U}/Items', P({ Filters: 'IsFavorite', Recursive: true, IncludeItemTypes: types, SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 40 }), 30000).then(items);
const query = (o) => () => get('/Users/{U}/Items', P(Object.assign({ Recursive: true, Limit: 30 }, o))).then(items);
const latest = (parentId) => () => get('/Users/{U}/Items/Latest', P({ ParentId: parentId, Limit: 30 }), 60000).then(items);


function genreRows(types, startOrder, count) {
  return get('/Genres', { UserId: '{U}', IncludeItemTypes: types, Recursive: true, SortBy: 'SortName', EnableTotalRecordCount: false }, 3600000)
    .then((r) => (r.Items || []).filter((g) => (g.ChildCount || g.MovieCount || g.SeriesCount || 0) >= 6)
      .sort((a, b) => (b.ChildCount || 0) - (a.ChildCount || 0)).slice(0, count)
      .map((g, j) => ({ id: 'g-' + types + '-' + g.Id, title: g.Name, order: startOrder + j, lazy: true,
        load: query({ GenreIds: g.Id, IncludeItemTypes: types, SortBy: 'Random', Limit: 30 }) })));
}

export function homeDefs() {
  return [
    { id: 'resume', title: 'Continue Watching for ' + S.name, order: 10, dynamic: true, playDirect: true, load: resume('Movie,Episode') },
    { id: 'nextup', title: 'Next Up', order: 20, dynamic: true, playDirect: true, load: nextUp },
    { id: 'favs', title: 'My List', order: 30, dynamic: true, load: favs('Movie,Series') },
    { id: 'views', expand: () => get('/Users/{U}/Views', {}, 3600000).then((r) => (r.Items || [])
      .filter((v) => v.CollectionType === 'movies' || v.CollectionType === 'tvshows')
      .map((v, j) => ({ id: 'latest-' + v.Id, title: 'Recently Added in ' + v.Name.replace(/_/g, ' '), kind: 'poster', order: 40 + j, dynamic: true, load: latest(v.Id) }))) },
    { id: 'top', title: 'Top Rated', order: 60, lazy: true, load: query({ IncludeItemTypes: 'Movie,Series', SortBy: 'CommunityRating', SortOrder: 'Descending', MinCommunityRating: 7 }) },
    { id: 'genres', expand: () => genreRows('Movie,Series', 70, 6) },
  ];
}

export function moviesDefs() {
  return [
    { id: 'resume', title: 'Continue Watching for ' + S.name, order: 10, dynamic: true, playDirect: true, load: resume('Movie') },
    { id: 'new', title: 'Recently Added', kind: 'poster', order: 20, dynamic: true, load: query({ IncludeItemTypes: 'Movie', SortBy: 'DateCreated', SortOrder: 'Descending' }) },
    { id: 'favs', title: 'My List', order: 30, dynamic: true, load: favs('Movie') },
    { id: 'top', title: 'Top Rated Movies', order: 40, lazy: true, load: query({ IncludeItemTypes: 'Movie', SortBy: 'CommunityRating', SortOrder: 'Descending', MinCommunityRating: 7 }) },
    { id: 'unwatched', title: 'Not Watched Yet', order: 50, lazy: true, load: query({ IncludeItemTypes: 'Movie', Filters: 'IsUnplayed', SortBy: 'Random' }) },
    { id: 'genres', expand: () => genreRows('Movie', 60, 8) },
  ];
}

export function showsDefs() {
  return [
    { id: 'resume', title: 'Continue Watching for ' + S.name, order: 10, dynamic: true, playDirect: true, load: resume('Episode') },
    { id: 'nextup', title: 'Next Up', order: 20, dynamic: true, playDirect: true, load: nextUp },
    { id: 'new', title: 'Recently Added Shows', kind: 'poster', order: 30, dynamic: true, load: query({ IncludeItemTypes: 'Series', SortBy: 'DateLastContentAdded', SortOrder: 'Descending' }) },
    { id: 'favs', title: 'My List', order: 40, dynamic: true, load: favs('Series') },
    { id: 'top', title: 'Top Rated Shows', order: 50, lazy: true, load: query({ IncludeItemTypes: 'Series', SortBy: 'CommunityRating', SortOrder: 'Descending' }) },
    { id: 'all', title: 'All Shows', order: 60, lazy: true, load: query({ IncludeItemTypes: 'Series', SortBy: 'SortName', Limit: 100 }) },
    { id: 'genres', expand: () => genreRows('Series', 70, 6) },
  ];
}

export function myListDefs() {
  return [{ id: 'favs', title: 'My List', order: 10, dynamic: true, grid: true, load: () => get('/Users/{U}/Items', P({ Filters: 'IsFavorite', Recursive: true, IncludeItemTypes: 'Movie,Series,Episode', SortBy: 'SortName', Limit: 200 }), 0).then(items) }];
}

export function search(term) {
  const rank = (it) => (it.Type === 'Episode' ? 1 : 0);
  return get('/Users/{U}/Items', P({ SearchTerm: term, Recursive: true, IncludeItemTypes: 'Movie,Series,Episode', Limit: 40 }), 300000)
    .then(items).then((list) => list.map((it, i) => [it, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]));
}

export const nextUpFor = (seriesId) => get('/Shows/NextUp', P({ UserId: '{U}', SeriesId: seriesId, Limit: 1, EnableResumable: true }), 0).then(items);
export { nextUp };
